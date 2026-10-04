import {
  DesktopHost,
  Geometry,
  MonitorInfo,
  MonitorSpec,
  OcrLine,
  Rect,
  WindowInfo,
  centerOf,
  imageToPhysical,
  physicalRectToImage,
  physicalToImage,
} from '../desktop/host';
import { parseKeys, parseModifiers } from '../desktop/keys';
import { Tool, ToolContext, ToolError, ToolResult, throwIfAborted, truncateMiddle } from './types';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function toToolError(err: unknown, signal: AbortSignal): ToolError {
  if (err instanceof ToolError) return err;
  if (signal.aborted) return new ToolError('Cancelled by the user.');
  return new ToolError(err instanceof Error ? err.message : String(err));
}

/** Wraps execute so helper failures reach the model as ToolError messages. */
function defineTool<I>(tool: Tool<I>): Tool<I> {
  return {
    ...tool,
    async execute(input: I, ctx: ToolContext) {
      try {
        return await tool.execute(input, ctx);
      } catch (err) {
        throw toToolError(err, ctx.signal);
      }
    },
  };
}

function num(value: unknown, name: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`${name} must be a number.`);
  return n;
}

function windowSpec(value: unknown, name = 'window'): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new ToolError(`${name} is required (a window title/process substring, or an hwnd number).`);
}

function monitorSpec(value: unknown): MonitorSpec | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'active' || text === 'primary' || text === 'all') return text;
  if (/^\d+$/.test(text)) return Number(text);
  throw new ToolError(`Invalid monitor "${value}". Use "active", "primary", "all" or a monitor number such as 0.`);
}

function describeWindow(w: WindowInfo | null | undefined): string {
  if (!w) return '(none)';
  return `"${w.title}" (${w.process || 'unknown process'}, pid ${w.pid}, hwnd ${w.hwnd})`;
}

function rectText(r: Rect): string {
  return `${r.x},${r.y} ${r.w}x${r.h}`;
}

function describeMonitors(monitors: MonitorInfo[]): string {
  return monitors.map((m) => `${m.index}${m.primary ? ' (primary)' : ''}: ${m.w}x${m.h} at physical (${m.x},${m.y})`).join('; ');
}

/** Converts a screenshot point to physical screen pixels, validating it lies inside the screenshot. */
async function resolvePoint(host: DesktopHost, x: unknown, y: unknown, signal: AbortSignal, label = ''): Promise<{ x: number; y: number }> {
  const ix = num(x, `${label}x`);
  const iy = num(y, `${label}y`);
  const g = await host.ensureGeometry(signal);
  if (ix < 0 || iy < 0 || ix > g.imageWidth || iy > g.imageHeight) {
    throw new ToolError(
      `${label}x/${label}y (${ix}, ${iy}) is outside the latest screenshot (${g.imageWidth}x${g.imageHeight}). ` +
        'Coordinates are pixels of the latest screenshot; take a new desktop_screenshot if the layout changed.',
    );
  }
  return imageToPhysical(g, ix, iy);
}

function activeSuffix(active: WindowInfo | null | undefined): string {
  return `Active window: ${describeWindow(active)}.`;
}

function windowLine(w: WindowInfo, g: Geometry | undefined): string {
  const rect = g ? physicalRectToImage(g, { x: w.x, y: w.y, w: w.w, h: w.h }) : { x: w.x, y: w.y, w: w.w, h: w.h };
  const flags = [w.active ? 'ACTIVE' : '', w.minimized ? 'minimized' : '', w.maximized ? 'maximized' : ''].filter(Boolean);
  return `hwnd ${w.hwnd} | "${w.title}" | ${w.process || '?'} pid ${w.pid} | rect ${w.minimized ? '(minimized)' : rectText(rect)}${flags.length ? ` | ${flags.join(', ')}` : ''}`;
}

const MONITOR_PARAM = {
  type: 'string',
  description: 'Which screen: "active" (the one with the focused window, default), "primary", "all" (every monitor stitched together), or a monitor number such as "1".',
};

const WINDOW_PARAM = {
  type: 'string',
  description: 'A window title or process-name substring (case-insensitive, e.g. "notepad"), or an hwnd number from desktop_list_windows.',
};

export function createDesktopTools(host: DesktopHost): Tool[] {
  if (process.platform !== 'win32') return [];

  const screenshotTool = defineTool<{ monitor?: MonitorSpec; region?: Rect }>({
    name: 'desktop_screenshot',
    label: 'Screenshot',
    kind: 'read',
    description:
      'Take a screenshot of the Windows desktop and look at it. This is how you see what is on screen: always do it before clicking and after an action to verify the result. ' +
      'COORDINATE CONTRACT: the latest screenshot defines the coordinate space. Every x/y you pass to desktop_click, desktop_move_mouse, desktop_drag and desktop_scroll is in pixels of the most recent screenshot image (origin = top-left), and element/OCR/window positions reported by other tools use the same space. ' +
      'The image may be downscaled from the physical screen; the result text states the scale. ' +
      'To read small text, pass region {x,y,w,h} (in the latest screenshot\'s coordinates) to zoom into that area at higher detail; the zoomed image then becomes the coordinate space, so take a normal screenshot again to return to the full screen. ' +
      'Prefer desktop_ui_tree / desktop_ui_click for controls that expose accessibility info; use coordinates for everything else.',
    parameters: {
      type: 'object',
      properties: {
        monitor: MONITOR_PARAM,
        region: {
          type: 'object',
          description: 'Zoom into this rectangle of the latest screenshot (its coordinates).',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
          required: ['x', 'y', 'w', 'h'],
        },
      },
    },
    summarize: (i) => (i.region ? `zoom ${rectText(i.region)}` : `monitor ${i.monitor ?? 'active'}`),
    async execute(input, ctx): Promise<ToolResult> {
      const region = input.region
        ? { x: num(input.region.x, 'region.x'), y: num(input.region.y, 'region.y'), w: num(input.region.w, 'region.w'), h: num(input.region.h, 'region.h') }
        : undefined;
      if (region && (region.w < 4 || region.h < 4)) throw new ToolError('region is too small.');
      const { image, reply, geometry } = await host.screenshot({ monitor: monitorSpec(input.monitor), region }, ctx.signal);
      const cursor = physicalToImage(geometry, reply.cursor.x, reply.cursor.y);
      const scale = Math.round(geometry.scale * 1000) / 1000;
      const lines = [
        `${region ? 'Zoomed screenshot' : 'Screenshot'} of ${reply.monitor < 0 ? 'all monitors' : `monitor ${reply.monitor}`}: ` +
          `physical area ${reply.w}x${reply.h} at (${reply.x},${reply.y}), image ${reply.imageWidth}x${reply.imageHeight}, scale ${scale} (image px per physical px).`,
        'Coordinates for desktop_click etc. are pixels of THIS image (origin top-left).' +
          (region ? ' This zoomed view is now the coordinate space; take a normal desktop_screenshot to return to the full screen.' : ''),
        `Active window: ${describeWindow(reply.active)}`,
        `Cursor: (${cursor.x}, ${cursor.y})${cursor.x < 0 || cursor.y < 0 || cursor.x > geometry.imageWidth || cursor.y > geometry.imageHeight ? ' (outside this image)' : ''}`,
        `Monitors: ${describeMonitors(reply.monitors)}`,
      ];
      return { text: lines.join('\n'), images: [{ mime: 'image/jpeg', data: image.toString('base64') }] };
    },
  });

  const listWindowsTool = defineTool<Record<string, never>>({
    name: 'desktop_list_windows',
    label: 'Windows',
    kind: 'read',
    description:
      'List the visible top-level windows (topmost first): hwnd, title, process name, pid, rectangle (in latest-screenshot coordinates), and whether each is minimized or the active window. ' +
      'Use the hwnd or a title substring with desktop_focus_window, desktop_window_action and desktop_ui_tree.',
    parameters: { type: 'object', properties: {} },
    summarize: () => 'visible windows',
    async execute(_input, ctx) {
      const g = await host.ensureGeometry(ctx.signal);
      const res = await host.request<{ windows: WindowInfo[] }>('windows', {}, 30_000, ctx.signal);
      if (!res.windows.length) return 'No visible windows.';
      return truncateMiddle(res.windows.map((w) => windowLine(w, g)).join('\n'));
    },
  });

  const listAppsTool = defineTool<{ query?: string }>({
    name: 'desktop_list_apps',
    label: 'Apps',
    kind: 'read',
    description:
      'List installed Start-menu apps (name and target) and the currently running windows. Use query to filter by name. ' +
      'Pass an app name from this list to desktop_launch_app.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Case-insensitive substring of the app name.' } },
    },
    summarize: (i) => i.query || 'all apps',
    async execute(input, ctx) {
      const g = await host.ensureGeometry(ctx.signal);
      const [apps, wins] = await Promise.all([
        host.request<{ apps: { name: string; target: string; kind: string }[]; total: number }>('apps', { query: input.query ?? '' }, 60_000, ctx.signal),
        host.request<{ windows: WindowInfo[] }>('windows', {}, 30_000, ctx.signal),
      ]);
      const out: string[] = [`Installed apps${input.query ? ` matching "${input.query}"` : ''} (${apps.total}${apps.total > apps.apps.length ? `, showing ${apps.apps.length}` : ''}):`];
      for (const a of apps.apps) out.push(`- ${a.name}${a.target ? `  [${a.kind === 'app' ? 'app id' : 'target'}: ${a.target}]` : ''}`);
      if (!apps.apps.length) out.push('(none)');
      out.push('', 'Running windows:');
      for (const w of wins.windows) out.push(`- ${windowLine(w, g)}`);
      return truncateMiddle(out.join('\n'));
    },
  });

  const launchTool = defineTool<{ name: string; args?: string; wait_for_window?: boolean; timeout_s?: number }>({
    name: 'desktop_launch_app',
    label: 'Launch',
    kind: 'interact',
    description:
      'Launch an application, file, folder or URL on the desktop. name can be an installed app name from desktop_list_apps ("Calculator", "Google Chrome"), an executable on PATH ("notepad.exe"), a full path, or a URL. ' +
      'By default it waits for the new window and returns its title, hwnd and pid. Afterwards take a desktop_screenshot to see it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App name, executable, path or URL.' },
        args: { type: 'string', description: 'Command-line arguments (for executables).' },
        wait_for_window: { type: 'boolean', description: 'Wait for a new window to appear (default true).' },
        timeout_s: { type: 'number', description: 'Max seconds to wait for the window (default 15, max 120).' },
      },
      required: ['name'],
    },
    summarize: (i) => i.name + (i.args ? ` ${i.args}` : ''),
    async execute(input, ctx) {
      if (!input.name?.trim()) throw new ToolError('name is empty.');
      const timeout = Math.min(Math.max(input.timeout_s ?? 15, 1), 120);
      const wait = input.wait_for_window !== false;
      const res = await host.request<{ via: string; pid: number; window: WindowInfo | null }>(
        'launch',
        { name: input.name, args: input.args, wait, timeout_s: timeout },
        (wait ? timeout : 0) * 1000 + 30_000,
        ctx.signal,
      );
      const head = `Launched "${input.name}" (${res.via}${res.pid ? `, pid ${res.pid}` : ''}).`;
      if (!wait) return head;
      if (res.window) return `${head}\nNew window: ${describeWindow(res.window)}`;
      return `${head}\nNo new window appeared within ${timeout}s (the app may reuse an existing window or still be starting). Use desktop_list_windows or desktop_screenshot to check.`;
    },
  });

  const focusTool = defineTool<{ window: string | number }>({
    name: 'desktop_focus_window',
    label: 'Focus',
    kind: 'interact',
    description: 'Bring a window to the foreground (restoring it if minimized). Do this before typing or pressing keys so input goes to the right application.',
    parameters: { type: 'object', properties: { window: WINDOW_PARAM }, required: ['window'] },
    summarize: (i) => String(i.window),
    async execute(input, ctx) {
      const res = await host.request<{ focused: boolean; window: WindowInfo | null; requested: WindowInfo }>(
        'focus',
        { window: windowSpec(input.window) },
        30_000,
        ctx.signal,
      );
      if (res.focused) return `Focused ${describeWindow(res.requested)}.`;
      return `Windows refused to bring ${describeWindow(res.requested)} to the foreground. Active window is still ${describeWindow(res.window)}. Try clicking the window, or desktop_window_action restore.`;
    },
  });

  const windowActionTool = defineTool<{ window: string | number; action: string; x?: number; y?: number; w?: number; h?: number }>({
    name: 'desktop_window_action',
    label: 'Window',
    kind: 'interact',
    description:
      'Minimize, maximize, restore, close or move/resize a window. "close" only sends a polite close request (like clicking the X): the app may show a "Save changes?" dialog that you must answer; windows are never force-killed. ' +
      'For "move", x/y/w/h are in latest-screenshot coordinates (x,y = new top-left; w,h = new size; omit w/h to keep the size).',
    parameters: {
      type: 'object',
      properties: {
        window: WINDOW_PARAM,
        action: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'close', 'move'] },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['window', 'action'],
    },
    summarize: (i) => `${i.action} ${i.window}`,
    async execute(input, ctx) {
      const action = String(input.action);
      if (!['minimize', 'maximize', 'restore', 'close', 'move'].includes(action)) throw new ToolError(`Unknown action "${action}".`);
      const args: Record<string, unknown> = { window: windowSpec(input.window), action };
      if (action === 'move') {
        if (input.x === undefined && input.y === undefined && input.w === undefined && input.h === undefined) throw new ToolError('move needs x/y and/or w/h.');
        const g = await host.ensureGeometry(ctx.signal);
        if ((input.x === undefined) !== (input.y === undefined)) throw new ToolError('Pass both x and y to move a window.');
        if ((input.w === undefined) !== (input.h === undefined)) throw new ToolError('Pass both w and h to resize a window.');
        if (input.x !== undefined && input.y !== undefined) {
          const p = imageToPhysical(g, num(input.x, 'x'), num(input.y, 'y'));
          args.x = p.x;
          args.y = p.y;
        }
        if (input.w !== undefined && input.h !== undefined) {
          args.w = Math.round(num(input.w, 'w') / g.scale);
          args.h = Math.round(num(input.h, 'h') / g.scale);
        }
      }
      const res = await host.request<{ window: WindowInfo | null; closed: boolean }>('window', args, 30_000, ctx.signal);
      if (action === 'close') {
        return res.closed
          ? 'Window closed.'
          : `Close requested. The window is still open (${describeWindow(res.window)}); it may be showing a confirmation dialog such as "Save changes?" - take a desktop_screenshot.`;
      }
      return `Done (${action}). Window is now ${describeWindow(res.window)}${res.window ? `, ${res.window.minimized ? 'minimized' : res.window.maximized ? 'maximized' : 'normal'}` : ''}.`;
    },
  });

  interface UiElement {
    ref: number;
    type: string;
    name: string;
    value: string | null;
    automationId: string;
    enabled: boolean;
    focused: boolean;
    state: string[];
    x: number;
    y: number;
    w: number;
    h: number;
    depth: number;
  }

  const uiTreeTool = defineTool<{ window?: string | number; query?: string; types?: string[]; max?: number; depth?: number }>({
    name: 'desktop_ui_tree',
    label: 'Inspect UI',
    kind: 'read',
    description:
      'Inspect a window\'s UI Automation (accessibility) tree: buttons, text boxes, menus, list items, links, etc. Each element gets a ref (#n) usable with desktop_ui_click and desktop_ui_set_value, plus its ControlType, Name, Value, AutomationId, state, and centre/rect in latest-screenshot coordinates. ' +
      'Much more reliable than guessing pixels. Defaults to the active window; use query (matches name/value/automation id) and types (e.g. ["Edit","Button"]) to narrow down big windows. ' +
      'Refs stay valid until the UI changes; if a ref stops working, run this again. Some apps (games, canvases, some Electron/Java UIs) expose little or nothing - fall back to screenshots and coordinates.',
    parameters: {
      type: 'object',
      properties: {
        window: { ...WINDOW_PARAM, description: 'Window to inspect: "active" (default), a title/process substring, or an hwnd number.' },
        query: { type: 'string', description: 'Only elements whose name, value, automation id or class contains this text.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Only these ControlTypes, e.g. ["Button","Edit","MenuItem","ListItem","CheckBox","ComboBox","TabItem","Hyperlink"].' },
        max: { type: 'integer', description: 'Maximum elements to return (default 80, max 400).' },
        depth: { type: 'integer', description: 'Maximum tree depth (default 12).' },
      },
    },
    summarize: (i) => [i.window ?? 'active', i.query ? `"${i.query}"` : '', i.types?.join(',') ?? ''].filter(Boolean).join(' '),
    async execute(input, ctx) {
      const g = await host.ensureGeometry(ctx.signal);
      const max = Math.min(Math.max(Math.trunc(input.max ?? 80), 1), 400);
      const res = await host.request<{ window: WindowInfo; elements: UiElement[]; visited: number; truncated: boolean }>(
        'ui_tree',
        {
          window: input.window === undefined ? 'active' : windowSpec(input.window),
          query: input.query,
          types: input.types,
          max,
          depth: input.depth ?? 12,
        },
        60_000,
        ctx.signal,
      );
      const out = [`Window: ${describeWindow(res.window)}`];
      if (!res.elements.length) {
        out.push('No matching elements. The window may expose no accessibility info, the query may not match, or it may be minimized/offscreen. Try desktop_find_text (OCR) or a screenshot.');
        return out.join('\n');
      }
      for (const el of res.elements) {
        const r = physicalRectToImage(g, el);
        const c = centerOf(r);
        const inside = c.x >= 0 && c.y >= 0 && c.x <= g.imageWidth && c.y <= g.imageHeight;
        const flags = [el.enabled ? '' : 'disabled', el.focused ? 'focused' : '', ...el.state].filter(Boolean);
        const parts = [`#${el.ref} ${el.type}`];
        if (el.name) parts.push(JSON.stringify(el.name));
        if (el.value) parts.push(`value=${JSON.stringify(el.value)}`);
        if (el.automationId) parts.push(`id=${el.automationId}`);
        parts.push(`center=(${c.x},${c.y}) rect=${rectText(r)}${inside ? '' : ' (outside latest screenshot)'}`);
        if (flags.length) parts.push(`[${flags.join(', ')}]`);
        out.push(`${'  '.repeat(Math.min(Math.max(el.depth - 1, 0), 6))}${parts.join(' ')}`);
      }
      if (res.truncated || res.elements.length >= max) out.push(`(output limited to ${res.elements.length} elements, ${res.visited} nodes scanned - narrow with query/types, or raise max)`);
      return truncateMiddle(out.join('\n'));
    },
  });

  const uiClickTool = defineTool<{ ref: number }>({
    name: 'desktop_ui_click',
    label: 'Click element',
    kind: 'interact',
    description:
      'Activate a UI element by its #ref from desktop_ui_tree: uses the accessibility Invoke / Toggle / Select / Expand patterns when available (works even if the element is partly hidden), otherwise performs a real mouse click at its centre.',
    parameters: { type: 'object', properties: { ref: { type: 'integer', description: 'Element number from desktop_ui_tree (the n in #n).' } }, required: ['ref'] },
    summarize: (i) => `#${i.ref}`,
    async execute(input, ctx) {
      const res = await host.request<{ method: string; name: string; active: WindowInfo | null }>('ui_click', { ref: num(input.ref, 'ref') }, 30_000, ctx.signal);
      return `Activated #${input.ref}${res.name ? ` "${res.name}"` : ''} via ${res.method}. ${activeSuffix(res.active)} Take a screenshot or desktop_ui_tree to verify.`;
    },
  });

  const uiSetValueTool = defineTool<{ ref: number; text: string }>({
    name: 'desktop_ui_set_value',
    label: 'Set value',
    kind: 'interact',
    description:
      'Replace the text of an edit/combo element (by #ref from desktop_ui_tree). Uses the accessibility ValuePattern when supported; otherwise focuses the element, selects all (ctrl+a) and types the text. Pass an empty string to clear it.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'Element number from desktop_ui_tree.' },
        text: { type: 'string', description: 'The new text.' },
      },
      required: ['ref', 'text'],
    },
    summarize: (i) => `#${i.ref} = ${JSON.stringify(String(i.text ?? '').slice(0, 40))}`,
    async execute(input, ctx) {
      if (typeof input.text !== 'string') throw new ToolError('text must be a string.');
      const res = await host.request<{ method: string; value: string | null; active: WindowInfo | null }>(
        'ui_set_value',
        { ref: num(input.ref, 'ref'), text: input.text },
        30_000 + input.text.length * 20,
        ctx.signal,
      );
      const shown = res.value === null ? 'unknown (element does not expose its value)' : JSON.stringify(res.value.length > 200 ? `${res.value.slice(0, 200)}...` : res.value);
      return `Set #${input.ref} via ${res.method}. Value now: ${shown}. ${activeSuffix(res.active)}`;
    },
  });

  const clickTool = defineTool<{ x: number; y: number; button?: string; double?: boolean; modifiers?: string }>({
    name: 'desktop_click',
    label: 'Click',
    kind: 'interact',
    description:
      'Move the mouse and click at (x, y), given in pixels of the LATEST desktop_screenshot (origin top-left; take a screenshot first, and a new one after anything moves). ' +
      'button: left (default), right or middle. double:true double-clicks. modifiers holds keys during the click, e.g. "ctrl" or "shift+ctrl". ' +
      'Prefer desktop_ui_click when the element appears in desktop_ui_tree. Verify the result with a screenshot.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in latest-screenshot pixels.' },
        y: { type: 'number', description: 'Y in latest-screenshot pixels.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean' },
        modifiers: { type: 'string', description: 'Keys to hold while clicking: ctrl, shift, alt, win (e.g. "ctrl+shift").' },
      },
      required: ['x', 'y'],
    },
    summarize: (i) => `${i.double ? 'double-' : ''}${i.button && i.button !== 'left' ? `${i.button}-` : ''}click (${i.x}, ${i.y})${i.modifiers ? ` +${i.modifiers}` : ''}`,
    async execute(input, ctx) {
      const button = input.button ?? 'left';
      if (!['left', 'right', 'middle'].includes(button)) throw new ToolError('button must be left, right or middle.');
      const modifiers = parseModifiers(input.modifiers);
      const p = await resolvePoint(host, input.x, input.y, ctx.signal);
      const res = await host.request<{ active: WindowInfo | null }>('click', { x: p.x, y: p.y, button, double: !!input.double, modifiers }, 30_000, ctx.signal);
      return `${input.double ? 'Double-clicked' : 'Clicked'} (${button}) at (${input.x}, ${input.y}) = physical (${p.x}, ${p.y}). ${activeSuffix(res.active)}`;
    },
  });

  const moveTool = defineTool<{ x: number; y: number }>({
    name: 'desktop_move_mouse',
    label: 'Move',
    kind: 'interact',
    description: 'Move the mouse pointer to (x, y) in latest-screenshot pixels without clicking (hover, to reveal tooltips or menus).',
    parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    summarize: (i) => `(${i.x}, ${i.y})`,
    async execute(input, ctx) {
      const p = await resolvePoint(host, input.x, input.y, ctx.signal);
      await host.request('move', p, 30_000, ctx.signal);
      return `Mouse moved to (${input.x}, ${input.y}) = physical (${p.x}, ${p.y}).`;
    },
  });

  const dragTool = defineTool<{ from_x: number; from_y: number; to_x: number; to_y: number }>({
    name: 'desktop_drag',
    label: 'Drag',
    kind: 'interact',
    description: 'Press the left mouse button at (from_x, from_y), move smoothly to (to_x, to_y) and release. All coordinates are pixels of the latest screenshot. Use for sliders, resizing, selecting text, drag-and-drop.',
    parameters: {
      type: 'object',
      properties: { from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
    summarize: (i) => `(${i.from_x}, ${i.from_y}) -> (${i.to_x}, ${i.to_y})`,
    async execute(input, ctx) {
      const from = await resolvePoint(host, input.from_x, input.from_y, ctx.signal, 'from_');
      const to = await resolvePoint(host, input.to_x, input.to_y, ctx.signal, 'to_');
      await host.request('drag', { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, 30_000, ctx.signal);
      return `Dragged from (${input.from_x}, ${input.from_y}) to (${input.to_x}, ${input.to_y}).`;
    },
  });

  const scrollTool = defineTool<{ x: number; y: number; amount: number; horizontal?: boolean }>({
    name: 'desktop_scroll',
    label: 'Scroll',
    kind: 'interact',
    description:
      'Scroll the mouse wheel with the pointer at (x, y) (latest-screenshot pixels). amount is in wheel notches: negative scrolls down (or left when horizontal), positive scrolls up (or right when horizontal). About 3 lines per notch; max 100.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        amount: { type: 'number', description: 'Wheel notches. Negative = down (left if horizontal), positive = up (right if horizontal).' },
        horizontal: { type: 'boolean', description: 'Scroll horizontally.' },
      },
      required: ['x', 'y', 'amount'],
    },
    summarize: (i) => `${i.horizontal ? 'horizontal ' : ''}${i.amount} at (${i.x}, ${i.y})`,
    async execute(input, ctx) {
      const amount = num(input.amount, 'amount');
      const p = await resolvePoint(host, input.x, input.y, ctx.signal);
      await host.request('scroll', { x: p.x, y: p.y, amount, horizontal: !!input.horizontal }, 30_000 + Math.abs(amount) * 30, ctx.signal);
      return `Scrolled ${amount} notches ${input.horizontal ? 'horizontally' : 'vertically'} at (${input.x}, ${input.y}).`;
    },
  });

  const typeTool = defineTool<{ text: string }>({
    name: 'desktop_type',
    label: 'Type',
    kind: 'interact',
    description:
      'Type text with the keyboard into whichever control currently has focus (Unicode supported; "\\n" presses Enter, "\\t" presses Tab). ' +
      'Make sure the right window and control are focused first (click it or desktop_focus_window); the result names the window that received the text. For shortcuts use desktop_press_keys.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to type.' } }, required: ['text'] },
    summarize: (i) => JSON.stringify(String(i.text ?? '').slice(0, 60)),
    async execute(input, ctx) {
      if (typeof input.text !== 'string' || !input.text.length) throw new ToolError('text is empty.');
      if (input.text.length > 20_000) throw new ToolError('text is too long (max 20000 characters); type it in parts or use the clipboard (desktop_clipboard_set + ctrl+v).');
      const res = await host.request<{ typed: number; active: WindowInfo | null }>('type', { text: input.text }, 30_000 + input.text.length * 25, ctx.signal);
      return `Typed ${res.typed} characters. ${activeSuffix(res.active)}`;
    },
  });

  const pressKeysTool = defineTool<{ keys: string; repeat?: number }>({
    name: 'desktop_press_keys',
    label: 'Keys',
    kind: 'interact',
    description:
      'Press a key or chord, e.g. "enter", "tab", "esc", "ctrl+s", "alt+f4", "win+r", "ctrl+shift+esc", "f5", "pagedown", "ctrl+a". Keys in a chord are separated by "+". ' +
      'Separate several chords with spaces to press them in order ("ctrl+a ctrl+c"). repeat presses the whole sequence multiple times (max 50). ' +
      'Keys go to the focused window; the result names it.',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'Chord(s) such as "ctrl+s" or "alt+tab".' },
        repeat: { type: 'integer', description: 'Times to repeat (default 1).' },
      },
      required: ['keys'],
    },
    summarize: (i) => i.keys + (i.repeat && i.repeat > 1 ? ` x${i.repeat}` : ''),
    async execute(input, ctx) {
      const chords = parseKeys(input.keys);
      const repeat = Math.min(Math.max(Math.trunc(input.repeat ?? 1), 1), 50);
      const res = await host.request<{ active: WindowInfo | null }>('keys', { chords, repeat }, 30_000 + repeat * chords.length * 300, ctx.signal);
      return `Pressed ${input.keys}${repeat > 1 ? ` x${repeat}` : ''}. ${activeSuffix(res.active)}`;
    },
  });

  const findTextTool = defineTool<{ text?: string; monitor?: MonitorSpec }>({
    name: 'desktop_find_text',
    label: 'Find text',
    kind: 'read',
    description:
      'OCR the screen (the area of the latest screenshot) and return recognised text lines with their centre and rectangle in latest-screenshot coordinates, ready for desktop_click. ' +
      'Pass text to return only lines containing it (case-insensitive; the reported centre is the matching words). Without text, every recognised line is returned. ' +
      'Uses Windows OCR in the user\'s profile languages; results can miss stylised or very small text - zoom with desktop_screenshot region if needed.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to look for (omit to list all text).' },
        monitor: MONITOR_PARAM,
      },
    },
    summarize: (i) => (i.text ? JSON.stringify(i.text) : 'all text'),
    async execute(input, ctx) {
      const monitor = monitorSpec(input.monitor);
      if (monitor !== undefined) await host.screenshot({ monitor }, ctx.signal);
      const { lines, language } = await host.ocr(ctx.signal);
      const needle = input.text?.replace(/\s+/g, ' ').trim().toLowerCase();
      const out: string[] = [];
      let count = 0;
      for (const line of lines) {
        let box: Rect = line;
        if (needle) {
          const found = matchBox(line, needle);
          if (!found) continue;
          box = found;
        }
        count++;
        const c = centerOf(box);
        out.push(`${JSON.stringify(line.text)} center=(${c.x},${c.y}) rect=${rectText(box)}`);
      }
      if (!out.length) {
        return needle
          ? `Text ${JSON.stringify(input.text)} was not found on screen via OCR (${lines.length} lines recognised, language ${language}). Check the spelling, zoom in with desktop_screenshot region, or look at a screenshot.`
          : `OCR recognised no text (language ${language}).`;
      }
      return truncateMiddle(`${count} ${needle ? 'matching ' : ''}line(s) (OCR language ${language}); coordinates are latest-screenshot pixels:\n${out.join('\n')}`);
    },
  });

  const clipboardGetTool = defineTool<Record<string, never>>({
    name: 'desktop_clipboard_get',
    label: 'Clipboard',
    kind: 'read',
    description: 'Read the text currently on the Windows clipboard (for example after selecting text and pressing ctrl+c).',
    parameters: { type: 'object', properties: {} },
    summarize: () => 'read clipboard',
    async execute(_input, ctx) {
      const res = await host.request<{ text: string; hasText: boolean; formats: string[] }>('clipboard_get', {}, 30_000, ctx.signal);
      if (!res.hasText) return `The clipboard holds no text${res.formats.length ? ` (formats: ${res.formats.join(', ')})` : ' (it is empty)'}.`;
      return truncateMiddle(res.text);
    },
  });

  const clipboardSetTool = defineTool<{ text: string }>({
    name: 'desktop_clipboard_set',
    label: 'Clipboard',
    kind: 'interact',
    description: 'Replace the Windows clipboard contents with the given text (then paste with desktop_press_keys "ctrl+v"). Overwrites whatever the user had copied.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    summarize: (i) => JSON.stringify(String(i.text ?? '').slice(0, 60)),
    async execute(input, ctx) {
      if (typeof input.text !== 'string') throw new ToolError('text must be a string.');
      await host.request('clipboard_set', { text: input.text }, 30_000, ctx.signal);
      return `Clipboard set (${input.text.length} characters).`;
    },
  });

  const waitTool = defineTool<{ seconds?: number; window_title?: string; text?: string; timeout_s?: number }>({
    name: 'desktop_wait',
    label: 'Wait',
    kind: 'read',
    description:
      'Wait for the desktop to settle. With only seconds: sleep that long (max 60). With window_title and/or text: poll until a window whose title (or process name) contains window_title exists and/or the OCR text appears on screen, up to timeout_s (default 20, max 120). ' +
      'A timeout is reported as a normal result, not an error.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Plain delay in seconds.' },
        window_title: { type: 'string', description: 'Wait for a window whose title or process name contains this.' },
        text: { type: 'string', description: 'Wait for this text to appear on screen (OCR).' },
        timeout_s: { type: 'number', description: 'Maximum wait for window_title/text (default 20).' },
      },
    },
    summarize: (i) => (i.window_title || i.text ? `for ${[i.window_title && `window "${i.window_title}"`, i.text && `text "${i.text}"`].filter(Boolean).join(' and ')}` : `${i.seconds ?? 1}s`),
    async execute(input, ctx) {
      const title = input.window_title?.trim().toLowerCase();
      const text = input.text?.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!title && !text) {
        const seconds = Math.min(Math.max(input.seconds ?? 1, 0), 60);
        await sleep(seconds * 1000, ctx.signal);
        throwIfAborted(ctx.signal);
        return `Waited ${seconds}s.`;
      }
      const timeout = Math.min(Math.max(input.timeout_s ?? 20, 1), 120);
      const start = Date.now();
      let seenWindow: WindowInfo | undefined;
      let seenText = false;
      while (Date.now() - start < timeout * 1000) {
        throwIfAborted(ctx.signal);
        if (title && !seenWindow) {
          const res = await host.request<{ windows: WindowInfo[] }>('windows', {}, 30_000, ctx.signal);
          seenWindow = res.windows.find((w) => w.title.toLowerCase().includes(title) || w.process.toLowerCase() === title);
        }
        if (text && !seenText && (!title || seenWindow)) {
          const { lines } = await host.ocr(ctx.signal);
          seenText = lines.some((l) => l.text.replace(/\s+/g, ' ').toLowerCase().includes(text));
        }
        if ((!title || seenWindow) && (!text || seenText)) {
          const parts = [seenWindow && `window ${describeWindow(seenWindow)} is open`, seenText && `text ${JSON.stringify(input.text)} is visible`].filter(Boolean);
          return `${parts.join(' and ')} (after ${((Date.now() - start) / 1000).toFixed(1)}s).`;
        }
        await sleep(text ? 1200 : 500, ctx.signal);
      }
      const missing = [title && !seenWindow && `window "${input.window_title}"`, text && !seenText && `text "${input.text}"`].filter(Boolean);
      return `Timed out after ${timeout}s waiting for ${missing.join(' and ')}. Take a desktop_screenshot to see the current state.`;
    },
  });

  return [
    screenshotTool,
    listWindowsTool,
    listAppsTool,
    launchTool,
    focusTool,
    windowActionTool,
    uiTreeTool,
    uiClickTool,
    uiSetValueTool,
    clickTool,
    moveTool,
    dragTool,
    scrollTool,
    typeTool,
    pressKeysTool,
    findTextTool,
    clipboardGetTool,
    clipboardSetTool,
    waitTool,
  ] as Tool[];
}

/** Bounding box of the OCR words covering `needle` inside the line (or the whole line if words can't be mapped). */
function matchBox(line: OcrLine, needle: string): Rect | undefined {
  const hay = line.text.replace(/\s+/g, ' ').toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx < 0) return undefined;
  let pos = 0;
  const hits: Rect[] = [];
  for (const word of line.words) {
    const w = word.text.toLowerCase();
    const at = hay.indexOf(w, pos);
    if (at < 0) continue;
    pos = at + w.length;
    if (pos > idx && at < idx + needle.length) hits.push(word);
  }
  if (!hits.length) return line;
  const x1 = Math.min(...hits.map((h) => h.x));
  const y1 = Math.min(...hits.map((h) => h.y));
  const x2 = Math.max(...hits.map((h) => h.x + h.w));
  const y2 = Math.max(...hits.map((h) => h.y + h.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
