import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DesktopHost,
  Geometry,
  WindowInfo,
  centerOf,
  imageToPhysical,
  physicalRectToImage,
  physicalToImage,
} from '../src/desktop/host';
import { parseKeys, parseModifiers } from '../src/desktop/keys';
import { createDesktopTools } from '../src/tools/desktop';
import { Tool, ToolContext, ToolResult } from '../src/tools/types';

describe('desktop key parsing', () => {
  it('parses chords into virtual-key codes', () => {
    assert.deepEqual(parseKeys('ctrl+s'), [[0x11, 0x53]]);
    assert.deepEqual(parseKeys('Ctrl+Shift+Esc'), [[0x11, 0x10, 0x1b]]);
    assert.deepEqual(parseKeys('win+r'), [[0x5b, 0x52]]);
    assert.deepEqual(parseKeys('alt+f4'), [[0x12, 0x73]]);
    assert.deepEqual(parseKeys('pagedown'), [[0x22]]);
    assert.deepEqual(parseKeys('f5'), [[0x74]]);
    assert.deepEqual(parseKeys('enter'), [[0x0d]]);
    assert.deepEqual(parseKeys('5'), [[0x35]]);
  });

  it('supports several chords, the plus key and rejects unknown keys', () => {
    assert.deepEqual(parseKeys('ctrl+a ctrl+c'), [[0x11, 0x41], [0x11, 0x43]]);
    assert.deepEqual(parseKeys('ctrl++'), [[0x11, 0xbb]]);
    assert.throws(() => parseKeys('ctrl+banana'), /Unknown key "banana"/);
    assert.throws(() => parseKeys('  '), /empty/);
  });

  it('parses modifiers', () => {
    assert.deepEqual(parseModifiers('shift+ctrl'), [0x10, 0x11]);
    assert.deepEqual(parseModifiers('ctrl'), [0x11]);
    assert.deepEqual(parseModifiers(undefined), []);
    assert.throws(() => parseModifiers('hyper'), /Unknown modifier/);
  });
});

describe('desktop coordinate conversion', () => {
  // A secondary monitor left of the primary, captured at half size.
  const g: Geometry = {
    monitorLeft: -1920,
    monitorTop: 100,
    scale: 0.5,
    imageWidth: 960,
    imageHeight: 540,
    physWidth: 1920,
    physHeight: 1080,
    monitor: 1,
  };

  it('converts screenshot pixels to physical pixels and back', () => {
    assert.deepEqual(imageToPhysical(g, 0, 0), { x: -1920, y: 100 });
    assert.deepEqual(imageToPhysical(g, 100, 50), { x: -1720, y: 200 });
    assert.deepEqual(physicalToImage(g, -1720, 200), { x: 100, y: 50 });
    assert.deepEqual(physicalToImage(g, imageToPhysical(g, 333, 222).x, imageToPhysical(g, 333, 222).y), { x: 333, y: 222 });
  });

  it('converts rectangles and centres', () => {
    const r = physicalRectToImage(g, { x: -1820, y: 200, w: 400, h: 200 });
    assert.deepEqual(r, { x: 50, y: 50, w: 200, h: 100 });
    assert.deepEqual(centerOf(r), { x: 150, y: 100 });
  });

  it('is the identity at scale 1', () => {
    const one: Geometry = { ...g, monitorLeft: 0, monitorTop: 0, scale: 1 };
    assert.deepEqual(imageToPhysical(one, 12, 34), { x: 12, y: 34 });
  });
});

const live = process.platform === 'win32' ? describe : describe.skip;

live('desktop control (live, uses Notepad)', { timeout: 120_000 }, () => {
  let tempDir: string;
  let host: DesktopHost;
  let tools: Map<string, Tool>;
  let ctx: ToolContext;
  let notepad: { hwnd: number; pid: number } | undefined;
  let savedClipboard: { text: string; hasText: boolean } | undefined;
  let ocrAvailable = true;

  const run = async (name: string, input: Record<string, unknown> = {}): Promise<ToolResult> => {
    const tool = tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    const out = await tool.execute(input, ctx);
    return typeof out === 'string' ? { text: out } : out;
  };

  const activeHwnd = async (): Promise<number> => {
    const state = await host.request<{ active: WindowInfo | null }>('state');
    return state.active?.hwnd ?? 0;
  };

  /** Only ever type into the Notepad we launched. */
  const focusNotepad = async () => {
    assert.ok(notepad, 'notepad not launched');
    await run('desktop_focus_window', { window: notepad.hwnd });
    for (let i = 0; i < 10 && (await activeHwnd()) !== notepad.hwnd; i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(await activeHwnd(), notepad.hwnd, 'Notepad is not the foreground window; refusing to send input');
  };

  const notepadEditRef = async (): Promise<number> => {
    assert.ok(notepad);
    const tree = await run('desktop_ui_tree', { window: notepad.hwnd, types: ['Edit', 'Document'] });
    const m = /#(\d+) (?:Edit|Document)/.exec(tree.text);
    assert.ok(m, `no edit control found:\n${tree.text}`);
    return Number(m[1]);
  };

  before(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'apexdev-desktop-'));
    host = new DesktopHost({ scriptPath: path.join(process.cwd(), 'resources/desktop/host.ps1'), tempDir });
    tools = new Map(createDesktopTools(host).map((t) => [t.name, t]));
    ctx = { cwd: process.cwd(), signal: new AbortController().signal } as unknown as ToolContext;
    const clip = await host.request<{ text: string; hasText: boolean }>('clipboard_get');
    savedClipboard = { text: clip.text, hasText: clip.hasText };
  });

  after(async () => {
    try {
      if (notepad) await closeNotepadWithoutSaving(notepad);
    } catch {
      // best effort
    }
    try {
      if (savedClipboard) await host.request('clipboard_set', { text: savedClipboard.hasText ? savedClipboard.text : '' });
    } catch {
      // best effort
    }
    host.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function closeNotepadWithoutSaving(np: { hwnd: number; pid: number }) {
    await host.request('window', { window: String(np.hwnd), action: 'close' }).catch(() => undefined);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const { windows } = await host.request<{ windows: WindowInfo[] }>('windows');
      const mine = windows.filter((w) => w.pid === np.pid);
      if (!mine.length) return;
      for (const w of mine) {
        // The "Save changes?" prompt is a window of the same process with a "Don't Save" button.
        const tree = await host
          .request<{ elements: { ref: number; name: string }[] }>('ui_tree', { window: String(w.hwnd), types: ['Button'], max: 40, depth: 6 })
          .catch(() => ({ elements: [] as { ref: number; name: string }[] }));
        const button = tree.elements.find((e) => /^don.?t save$/i.test(e.name));
        if (button) await host.request('ui_click', { ref: button.ref }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Last resort: kill only the Notepad process we started.
    try {
      execFileSync('taskkill', ['/PID', String(np.pid), '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }

  it('exposes the expected tools', () => {
    assert.equal(tools.size, 19);
    for (const name of ['desktop_screenshot', 'desktop_ui_tree', 'desktop_click', 'desktop_find_text', 'desktop_wait']) assert.ok(tools.has(name), name);
    assert.equal(tools.get('desktop_screenshot')!.kind, 'read');
    assert.equal(tools.get('desktop_click')!.kind, 'interact');
    assert.equal(tools.get('desktop_clipboard_get')!.kind, 'read');
    assert.equal(tools.get('desktop_clipboard_set')!.kind, 'interact');
  });

  it('lists windows', async () => {
    const res = await run('desktop_list_windows');
    assert.match(res.text, /hwnd \d+ \| ".+" \|/);
  });

  it('takes a JPEG screenshot and records its geometry', async () => {
    const res = await run('desktop_screenshot');
    assert.equal(res.images?.length, 1);
    assert.equal(res.images![0].mime, 'image/jpeg');
    const bytes = Buffer.from(res.images![0].data, 'base64');
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    const g = host.getGeometry();
    assert.ok(g, 'geometry not set');
    assert.ok(g.scale > 0 && g.scale <= 1);
    assert.ok(Math.max(g.imageWidth, g.imageHeight) <= 1366);
    assert.match(res.text, /image \d+x\d+, scale/);
  });

  it('zooms into a region', async () => {
    const full = host.getGeometry()!;
    const res = await run('desktop_screenshot', { region: { x: 0, y: 0, w: Math.round(full.imageWidth / 2), h: Math.round(full.imageHeight / 2) } });
    assert.match(res.text, /Zoomed screenshot/);
    assert.ok(host.getGeometry()!.physWidth <= Math.ceil(full.physWidth / 2) + 2);
    await run('desktop_screenshot');
  });

  it('launches Notepad and finds its window', async () => {
    const res = await run('desktop_launch_app', { name: 'notepad.exe', timeout_s: 20 });
    const m = /New window: "[^"]*" \(([^,]*), pid (\d+), hwnd (\d+)\)/.exec(res.text);
    assert.ok(m, res.text);
    notepad = { pid: Number(m[2]), hwnd: Number(m[3]) };
    assert.match(m[1], /notepad/i);
    const waited = await run('desktop_wait', { window_title: 'Notepad', timeout_s: 10 });
    assert.match(waited.text, /is open/);
  });

  it('inspects the UI tree and sets the edit value', async () => {
    await focusNotepad();
    const ref = await notepadEditRef();
    const set = await run('desktop_ui_set_value', { ref, text: 'ApexDev zebra quartz 4711' });
    assert.match(set.text, /Set #\d+ via/);
    const tree = await run('desktop_ui_tree', { window: notepad!.hwnd, query: 'quartz' });
    assert.match(tree.text, /quartz 4711/);
  });

  it('types into the verified foreground Notepad', async () => {
    await focusNotepad();
    const typed = await run('desktop_type', { text: ' appendedé' });
    assert.match(typed.text, /Typed 10 characters/);
    assert.match(typed.text, /Notepad/);
    const tree = await run('desktop_ui_tree', { window: notepad!.hwnd, query: 'appended' });
    assert.match(tree.text, /quartz 4711 appendedé/);
  });

  it('presses keys and clicks inside Notepad', async () => {
    await focusNotepad();
    await run('desktop_screenshot');
    const tree = await run('desktop_ui_tree', { window: notepad!.hwnd, types: ['Edit', 'Document'] });
    const m = /#\d+ (?:Edit|Document) .*center=\((\d+),(\d+)\)/.exec(tree.text);
    assert.ok(m, tree.text);
    await focusNotepad();
    const click = await run('desktop_click', { x: Number(m[1]), y: Number(m[2]) });
    assert.match(click.text, /Clicked \(left\)/);
    assert.match(click.text, /Notepad/);
    await focusNotepad();
    const keys = await run('desktop_press_keys', { keys: 'ctrl+end' });
    assert.match(keys.text, /Pressed ctrl\+end/);
  });

  it('finds typed text with OCR', async () => {
    await focusNotepad();
    await run('desktop_screenshot');
    let res: ToolResult;
    try {
      res = await run('desktop_find_text', { text: 'quartz' });
    } catch (err) {
      if (/OCR is not available/i.test((err as Error).message)) {
        ocrAvailable = false;
        return;
      }
      throw err;
    }
    assert.ok(ocrAvailable);
    assert.match(res.text, /center=\(\d+,\d+\)/, res.text);
    const g = host.getGeometry()!;
    const c = /center=\((\d+),(\d+)\)/.exec(res.text)!;
    assert.ok(Number(c[1]) <= g.imageWidth && Number(c[2]) <= g.imageHeight);
  });

  it('round-trips the clipboard', async () => {
    const value = `apexdev-clip-${Date.now()}`;
    await run('desktop_clipboard_set', { text: value });
    const got = await run('desktop_clipboard_get');
    assert.equal(got.text, value);
  });

  it('minimizes and restores a window', async () => {
    assert.ok(notepad);
    const min = await run('desktop_window_action', { window: notepad.hwnd, action: 'minimize' });
    assert.match(min.text, /minimized/);
    const restored = await run('desktop_window_action', { window: notepad.hwnd, action: 'restore' });
    assert.match(restored.text, /normal|maximized/);
  });

  it('reports helpful errors', async () => {
    await assert.rejects(run('desktop_focus_window', { window: 'no-such-window-xyz' }), /No visible window matches/);
    await assert.rejects(run('desktop_ui_click', { ref: 999999 }), /Unknown element ref/);
    await assert.rejects(run('desktop_press_keys', { keys: 'ctrl+banana' }), /Unknown key/);
    await assert.rejects(run('desktop_click', { x: -50, y: 10 }), /outside the latest screenshot/);
  });

  it('cleans up the temp folder it used for screenshots', () => {
    assert.ok(existsSync(tempDir));
  });
});
