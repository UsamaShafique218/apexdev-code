import { ToolError } from '../tools/types';

const MODIFIERS: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, menu: 0x12, option: 0x12,
  win: 0x5b, windows: 0x5b, meta: 0x5b, super: 0x5b, cmd: 0x5b, command: 0x5b,
};

const NAMED_KEYS: Record<string, number> = {
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20, spacebar: 0x20,
  backspace: 0x08, bksp: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2c, prtsc: 0x2c, pause: 0x13,
  apps: 0x5d, contextmenu: 0x5d,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad, playpause: 0xb3, nexttrack: 0xb0, prevtrack: 0xb1,
  plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe, dot: 0xbe, slash: 0xbf,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

/** Virtual-key code for a single key name ("a", "5", "f5", "enter", "pagedown"...), or undefined. */
export function keyCode(name: string): number | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  if (MODIFIERS[key] !== undefined) return MODIFIERS[key];
  if (NAMED_KEYS[key] !== undefined) return NAMED_KEYS[key];
  if (/^[a-z]$/.test(key)) return key.charCodeAt(0) - 97 + 0x41;
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0) - 48 + 0x30;
  const fn = /^f(\d{1,2})$/.exec(key);
  if (fn && +fn[1] >= 1 && +fn[1] <= 24) return 0x70 + +fn[1] - 1;
  const num = /^(?:num|numpad)([0-9])$/.exec(key);
  if (num) return 0x60 + +num[1];
  return undefined;
}

/**
 * Parses key chords into virtual-key code lists, e.g. "ctrl+shift+esc" -> [[0x11, 0x10, 0x1b]].
 * Several chords can be separated by spaces: "ctrl+a ctrl+c" -> two chords pressed in turn.
 * Within a chord the keys are pressed in the given order and released in reverse.
 */
export function parseKeys(spec: string): number[][] {
  if (typeof spec !== 'string' || !spec.trim()) throw new ToolError('keys is empty.');
  const chords: number[][] = [];
  for (const raw of spec.trim().split(/\s+/)) {
    // "ctrl++" means ctrl and the plus key; a lone "+" is the plus key too.
    const parts = raw === '+' ? ['plus'] : raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), 'plus'] : raw.split('+');
    const codes: number[] = [];
    for (const part of parts) {
      const code = keyCode(part);
      if (code === undefined) throw new ToolError(`Unknown key "${part}" in "${raw}". Use names like ctrl, shift, alt, win, enter, esc, tab, space, backspace, delete, home, end, pageup, pagedown, up, down, left, right, f1-f24, a-z, 0-9.`);
      if (!codes.includes(code)) codes.push(code);
    }
    chords.push(codes);
  }
  if (!chords.length) throw new ToolError('keys is empty.');
  return chords;
}

/** Parses "ctrl", "shift+ctrl", "alt,shift" into modifier key codes. */
export function parseModifiers(spec: string | undefined): number[] {
  if (!spec || !spec.trim()) return [];
  const codes: number[] = [];
  for (const part of spec.split(/[+,\s]+/)) {
    if (!part) continue;
    const code = MODIFIERS[part.toLowerCase()];
    if (code === undefined) throw new ToolError(`Unknown modifier "${part}". Use ctrl, shift, alt or win.`);
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}
