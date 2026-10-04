import { BrowserSession, PageState, abortable, sleep } from '../browser/session';
import { CdpError } from '../browser/cdp';
import { Tool, ToolError, ToolResult, throwIfAborted, truncateMiddle } from './types';

// ---------------------------------------------------------------------------
// URL normalisation

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})(:\d+)?([/?#].*)?$/i;
const DOMAIN = /^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/;
const HOST_PORT = /^[\w.-]+:\d+([/?#].*)?$/;

/** Turns what the model typed (URL, bare domain, localhost:3000, search words) into a navigable URL. */
export function normalizeUrl(input: string): string {
  const value = (input ?? '').trim();
  if (!value) throw new ToolError('url is empty.');
  if (/^javascript:/i.test(value)) throw new ToolError('javascript: URLs are not supported. Use browser_eval to run code in the page.');
  if (!HOST_PORT.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(value) && !/\s/.test(value.split(':')[0])) return value;
  if (/^\/\//.test(value)) return `https:${value}`;
  if (!/\s/.test(value)) {
    if (LOCAL_HOST.test(value)) return `http://${value}`;
    if (DOMAIN.test(value) || IPV4.test(value) || HOST_PORT.test(value)) return `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

// ---------------------------------------------------------------------------
// Scripts that run inside the page

/** Shared helpers; every script below is wrapped in its own function scope together with this prelude. */
const PRELUDE = String.raw`
const REF = 'data-apexdev-ref';
const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=treeitem],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
function rootsOf() {
  const out = [document]; const stack = [document];
  while (stack.length) {
    const r = stack.pop();
    for (const el of r.querySelectorAll('*')) if (el.shadowRoot) { out.push(el.shadowRoot); stack.push(el.shadowRoot); }
  }
  return out;
}
const ROOTS = rootsOf();
function qsaDeep(sel) { const res = []; for (const r of ROOTS) for (const e of r.querySelectorAll(sel)) res.push(e); return res; }
function trunc(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && cs.display !== 'none';
}
function within(el, m) {
  while (el) { if (el === m) return true; el = el.parentNode || el.host; }
  return false;
}
function roleOf(el) {
  const r = el.getAttribute('role');
  if (r) return r.split(' ')[0];
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return t;
    if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
    if (t === 'range') return 'slider';
    if (t === 'search') return 'searchbox';
    if (t === 'file') return 'file-input';
    return 'textbox';
  }
  if (el.isContentEditable) return 'textbox';
  return tag;
}
function nameOf(el) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const rn = el.getRootNode();
    const t = lb.split(/\s+/).map((id) => { const n = rn.getElementById ? rn.getElementById(id) : null; return n ? (n.textContent || '').trim() : ''; }).filter(Boolean).join(' ');
    if (t) return t;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => l.innerText || l.textContent || '').join(' ').trim();
      if (t) return t;
    }
    const type = (el.type || '').toLowerCase();
    if (tag === 'input' && ['submit', 'button', 'reset'].includes(type)) return el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    if (tag === 'input' && type === 'image') return el.alt || '';
    return el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }
  let t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!t) { const img = el.querySelector('img[alt],svg title'); if (img) t = (img.getAttribute('alt') || img.textContent || '').trim(); }
  if (!t) t = el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('value') || '';
  return t;
}
function describe(el) {
  const ref = el.getAttribute(REF);
  const name = trunc(nameOf(el), 60);
  return (ref ? '[' + ref + '] ' : '') + roleOf(el) + (name ? ' "' + name + '"' : '');
}
function deepFromPoint(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
  return el;
}
function findTarget(t) {
  if (!t) return { error: 'Specify ref, selector or text.' };
  if (t.ref != null) {
    const el = qsaDeep('[' + REF + '="' + t.ref + '"]')[0];
    if (!el) return { error: 'No element with ref [' + t.ref + '] on the page (refs are reset by browser_read / browser_navigate and the page may have changed). Call browser_read to get fresh refs.' };
    return { el };
  }
  if (t.selector) {
    let list;
    try { list = qsaDeep(t.selector); } catch (e) { return { error: 'Invalid CSS selector: ' + t.selector }; }
    if (!list.length) return { error: 'No element matches selector ' + t.selector + '. Call browser_read to see what is on the page.' };
    return { el: list.find(visible) || list[0] };
  }
  if (t.text) {
    const needle = String(t.text).trim().toLowerCase();
    let best = null, bestScore = 9;
    for (const el of qsaDeep('*')) {
      if (el === document.documentElement || el === document.body) continue;
      const hay = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('value') || '')).toLowerCase();
      if (!hay.includes(needle)) continue;
      if (!visible(el)) continue;
      const interactive = el.matches(INTERACTIVE);
      const label = (interactive ? nameOf(el) : (el.innerText || '')).replace(/\s+/g, ' ').trim().toLowerCase();
      let score = 9;
      if (interactive) {
        if (label === needle) score = 0; else if (label.includes(needle)) score = 1;
        else if (hay.includes(needle)) score = 4;
      } else if (label.includes(needle) && ![...el.children].some((c) => ((c.innerText || '').toLowerCase()).includes(needle))) {
        score = label === needle ? 2 : 3;
      }
      if (score < bestScore) { best = el; bestScore = score; if (score === 0) break; }
    }
    if (!best) return { error: 'No visible element contains the text "' + t.text + '". Call browser_read to see what is on the page.' };
    return { el: best };
  }
  return { error: 'Specify ref, selector or text.' };
}
function nativeSet(el, v) {
  const tag = el.tagName.toLowerCase();
  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : tag === 'select' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
}
function fire(el, names) { for (const n of names) el.dispatchEvent(new Event(n, { bubbles: true })); }
function scrollInfo() {
  const de = document.documentElement;
  return { y: Math.round(scrollY), max: Math.max(0, Math.round(de.scrollHeight - innerHeight)), vh: innerHeight, vw: innerWidth };
}
`;

const READ_SCRIPT = String.raw`
for (const e of qsaDeep('[' + REF + ']')) e.removeAttribute(REF);
let scope = null;
if (A.selector) {
  try { scope = qsaDeep(A.selector).slice(0, 20); } catch (e) { return { error: 'Invalid CSS selector: ' + A.selector }; }
  if (!scope.length) return { error: 'No element matches selector ' + A.selector };
}
let text;
if (scope) text = scope.map((e) => e.innerText || e.textContent || '').join('\n');
else text = (document.body ? document.body.innerText : '') || (document.documentElement ? document.documentElement.textContent : '') || '';
text = text.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 400000);
const q = A.query ? String(A.query).toLowerCase() : '';
const items = [];
for (const el of qsaDeep('*')) {
  if (el === document.documentElement || el === document.body) continue;
  if (scope && !scope.some((m) => within(el, m))) continue;
  let role = null;
  const matched = el.matches(INTERACTIVE);
  if (!visible(el)) continue;
  if (matched) role = roleOf(el);
  else {
    const cs = getComputedStyle(el);
    if (cs.cursor === 'pointer' && !el.closest(INTERACTIVE)) {
      const p = el.parentElement;
      const t = (el.innerText || '').trim();
      if ((!p || getComputedStyle(p).cursor !== 'pointer') && t.length > 0 && t.length < 120) role = 'clickable';
    }
  }
  if (!role) continue;
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? (el.type || 'text').toLowerCase() : '';
  const name = trunc(nameOf(el), 80);
  const attrs = [];
  let value = '';
  if (tag === 'select') { const o = el.selectedOptions && el.selectedOptions[0]; value = o ? trunc(o.text, 40) : ''; }
  else if ((tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) || tag === 'textarea') value = type === 'password' ? (el.value ? '••••' : '') : trunc(el.value, 40);
  else if (el.isContentEditable && role === 'textbox') value = trunc(el.innerText, 40);
  if (value) attrs.push('value="' + value + '"');
  const ph = el.getAttribute('placeholder');
  if (ph) attrs.push('placeholder="' + trunc(ph, 40) + '"');
  if (tag === 'input' && !['text', 'checkbox', 'radio', 'submit', 'button', 'reset', 'search', 'image'].includes(type)) attrs.push('type=' + type);
  if ((el.checked === true) || el.getAttribute('aria-checked') === 'true') attrs.push('checked');
  if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
  if (el.getAttribute('aria-expanded')) attrs.push('expanded=' + el.getAttribute('aria-expanded'));
  if (el.getAttribute('aria-selected') === 'true') attrs.push('selected');
  let href = '';
  if (tag === 'a') {
    const h = el.getAttribute('href') || '';
    try { const u = new URL(h, location.href); href = trunc(u.origin === location.origin ? u.pathname + u.search + u.hash : u.host + u.pathname + u.search, 80); } catch (e) { href = trunc(h, 80); }
    if (href) attrs.push('href=' + href);
  }
  if (q && !(role + ' ' + name + ' ' + attrs.join(' ')).toLowerCase().includes(q)) continue;
  items.push({ el, role, name, attrs });
}
const shown = items.slice(0, A.maxItems);
const elements = shown.map((it, i) => { it.el.setAttribute(REF, String(i + 1)); return { ref: i + 1, role: it.role, name: it.name, attrs: it.attrs }; });
return { title: document.title, url: location.href, text, elements, total: items.length, scroll: scrollInfo() };
`;

const LOCATE_SCRIPT = String.raw`
const f = findTarget(A.target);
if (f.error) return f;
const el = f.el;
const tag = el.tagName.toLowerCase();
if (A.action === 'click') {
  if (tag === 'select') return { error: 'This is a <select> dropdown; native popups cannot be clicked. Use browser_type with this ref and the option text (or value) to choose an option.' };
  if (tag === 'input' && (el.type || '').toLowerCase() === 'file') return { error: 'This is a file input; file chooser dialogs cannot be operated with this tool.' };
}
el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
const r = rects[0] || el.getBoundingClientRect();
if (r.width <= 0 || r.height <= 0) return { error: 'Element is not visible (zero size): ' + describe(el) };
const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1));
const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
const hit = deepFromPoint(x, y);
let covered = '';
if (hit && !within(hit, el) && !within(el, hit)) covered = describe(hit) || hit.tagName.toLowerCase();
return { x, y, desc: describe(el), covered, disabled: el.disabled === true };
`;

const PREPARE_TYPE_SCRIPT = String.raw`
let el;
if (A.target) { const f = findTarget(A.target); if (f.error) return f; el = f.el; }
else {
  el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { error: 'No element is focused. Pass ref, selector or click a field first.' };
}
const tag = el.tagName.toLowerCase();
const type = (el.type || '').toLowerCase();
const desc = describe(el);
if (A.target) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
if (el.disabled === true) return { error: 'The field is disabled: ' + desc };
if (tag === 'select') {
  const want = String(A.text).trim().toLowerCase();
  const opts = [...el.options];
  const opt = opts.find((o) => o.value.toLowerCase() === want) || opts.find((o) => o.text.trim().toLowerCase() === want) || opts.find((o) => o.text.toLowerCase().includes(want));
  if (!opt) return { error: 'No option "' + A.text + '" in ' + desc + '. Options: ' + opts.slice(0, 15).map((o) => '"' + trunc(o.text, 40) + '"').join(', ') };
  nativeSet(el, opt.value);
  fire(el, ['input', 'change']);
  return { kind: 'done', desc, value: trunc(opt.text, 80) };
}
if (tag === 'input' && ['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return { error: 'Cannot type into a ' + type + ' input (' + desc + '). Use browser_click.' };
if (tag === 'input' && ['date', 'time', 'datetime-local', 'month', 'week', 'range', 'color'].includes(type)) {
  nativeSet(el, A.text); fire(el, ['input', 'change']);
  return { kind: 'done', desc, value: el.value };
}
if (tag === 'input' || tag === 'textarea') {
  if (el.readOnly) return { error: 'The field is read-only: ' + desc };
  el.focus();
  if (A.clear) {
    try { el.select(); } catch (e) {}
    document.execCommand('delete');
    if (el.value) { nativeSet(el, ''); fire(el, ['input']); }
  } else {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
  }
  return { kind: 'text', desc };
}
if (el.isContentEditable) {
  el.focus();
  const sel = getSelection(); const range = document.createRange();
  range.selectNodeContents(el);
  if (A.clear) { sel.removeAllRanges(); sel.addRange(range); document.execCommand('delete'); }
  else { range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
  return { kind: 'text', desc };
}
return { error: 'Element is not editable: ' + desc + '. Click it first, or pick an input/textarea.' };
`;

const ACTIVE_VALUE_SCRIPT = String.raw`
let a = document.activeElement;
while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
if (!a || a === document.body) return null;
const type = (a.type || '').toLowerCase();
let v = a.value !== undefined ? a.value : (a.isContentEditable ? a.innerText : '');
if (type === 'password') v = '•'.repeat(String(v).length);
return { desc: describe(a), value: trunc(v, 100) };
`;

const SCROLL_SCRIPT = String.raw`
if (A.to === 'top') scrollTo({ top: 0, behavior: 'instant' });
else if (A.to === 'bottom') scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
return scrollInfo();
`;

const INFO_SCRIPT = 'return scrollInfo();';

async function run<T = any>(session: BrowserSession, page: PageState, body: string, args: object = {}): Promise<T> {
  const code = `(() => {\n${PRELUDE}\nconst A = ${JSON.stringify(args)};\n${body}\n})()`;
  const result = await session.evaluate<any>(page, code, { awaitPromise: false, timeoutMs: 20_000 });
  if (result && typeof result === 'object' && typeof result.error === 'string') throw new ToolError(result.error);
  return result as T;
}

// ---------------------------------------------------------------------------
// Formatting helpers

interface ReadResult {
  title: string;
  url: string;
  text: string;
  elements: { ref: number; role: string; name: string; attrs: string[] }[];
  total: number;
  scroll: { y: number; max: number; vh: number };
}

async function readPage(session: BrowserSession, page: PageState, opts: { selector?: string; query?: string; maxChars?: number; maxItems?: number }, notes: string[] = []): Promise<string> {
  const dialog = session.dialogMessage(page);
  if (dialog) {
    const info = await session.pageInfo(page);
    return `Page: ${info.title || '(untitled)'}\nURL: ${info.url}\n${dialog}\n(Page content is unavailable until the dialog is handled.)`;
  }
  const maxChars = Math.max(200, Math.floor(opts.maxChars ?? 8000));
  const maxItems = Math.max(1, Math.floor(opts.maxItems ?? 150));
  const r = await run<ReadResult>(session, page, READ_SCRIPT, { selector: opts.selector, query: opts.query, maxItems });

  const lines: string[] = [];
  for (const note of notes) lines.push(note);
  lines.push(`Page: ${r.title || '(untitled)'}`, `URL: ${r.url}`);
  if (r.scroll.max > 0) lines.push(`Scroll: ${r.scroll.y} of ${r.scroll.max}px (viewport ${r.scroll.vh}px high)`);
  lines.push('', opts.selector ? `--- Text of "${opts.selector}" ---` : '--- Text ---');
  lines.push(r.text ? truncateMiddle(r.text, maxChars) : '(no visible text)');
  const header = opts.query
    ? `--- Interactive elements matching "${opts.query}" (${r.elements.length < r.total ? `showing ${r.elements.length} of ${r.total}` : r.total}) ---`
    : `--- Interactive elements (${r.elements.length < r.total ? `showing ${r.elements.length} of ${r.total}` : r.total}) ---`;
  lines.push('', header);
  if (!r.elements.length) lines.push('(none)');
  for (const e of r.elements) {
    const attrs = e.attrs.length ? ` (${e.attrs.join(', ')})` : '';
    lines.push(`[${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ''}${attrs}`);
  }
  if (r.elements.length < r.total) lines.push(`… ${r.total - r.elements.length} more elements; use query, selector or max_items to see them.`);
  return lines.join('\n');
}

function describeKey(key: string): string {
  return key;
}

async function afterAction(session: BrowserSession, page: PageState, before: { url: string }, tabsBefore: Set<string>, notes: string[]): Promise<string> {
  const info = await session.pageInfo(page);
  const lines = [...notes];
  lines.push(`Page: "${info.title || '(untitled)'}" ${info.url}`);
  if (info.url && before.url && info.url !== before.url) lines.push(`URL changed from ${before.url}`);
  try {
    const tabs = await session.listTabs();
    for (const tab of tabs) {
      if (!tabsBefore.has(tab.targetId)) lines.push(`A new tab opened: tab ${tab.index} "${tab.title || '(loading)'}" ${tab.url}. Use browser_tabs with action "switch" to look at it.`);
    }
  } catch {
    // tab listing is only a hint
  }
  const dialog = session.dialogMessage(page);
  if (dialog) lines.push(dialog);
  else lines.push('Call browser_read to see the updated page.');
  return lines.join('\n');
}

async function snapshotTabs(session: BrowserSession): Promise<Set<string>> {
  try {
    return new Set((await session.listTabs()).map((t) => t.targetId));
  } catch {
    return new Set();
  }
}

function formatTabs(tabs: { index: number; title: string; url: string; current: boolean }[]): string {
  return tabs.map((t) => `${t.current ? '*' : ' '} ${t.index}. ${t.title || '(untitled)'} - ${t.url}`).join('\n') + '\n(* = current tab)';
}

function blockingDialog(session: BrowserSession, page: PageState): void {
  const message = session.dialogMessage(page);
  if (message) throw new ToolError(message);
}

interface Target {
  ref?: number;
  selector?: string;
  text?: string;
}

function pickTarget(input: Target, optional = false): Target | undefined {
  const target: Target = {};
  if (input.ref !== undefined && input.ref !== null) {
    const ref = Number(input.ref);
    if (!Number.isInteger(ref)) throw new ToolError('ref must be the number shown in brackets by browser_read, e.g. 3.');
    target.ref = ref;
  } else if (input.selector) target.selector = String(input.selector);
  else if (input.text) target.text = String(input.text);
  else if (optional) return undefined;
  else throw new ToolError('Specify ref (from browser_read), selector or text to identify the element.');
  return target;
}

function targetSummary(input: Target): string {
  if (input.ref !== undefined && input.ref !== null) return `[${input.ref}]`;
  if (input.selector) return input.selector;
  if (input.text) return `"${input.text}"`;
  return '';
}

// ---------------------------------------------------------------------------
// Keys

interface KeyDef {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

const MODIFIERS: Record<string, { bit: number; key: string; code: string; vk: number }> = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  option: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  command: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  win: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vk: 16 },
};

const EDIT_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

export interface ParsedKey extends KeyDef {
  modifiers: number;
  commands?: string[];
}

/** Parses "Enter", "ArrowDown", "ctrl+a", "shift+Tab", "a", "F5" into a CDP key event description. */
export function parseKey(spec: string): ParsedKey {
  const raw = (spec ?? '').trim();
  if (!raw) throw new ToolError('key is empty.');
  let parts: string[];
  if (raw === '+') parts = ['+'];
  else if (raw.endsWith('++')) parts = [...raw.slice(0, -2).split('+'), '+'];
  else parts = raw.split('+').map((p) => p.trim());
  let modifiers = 0;
  const last = parts[parts.length - 1];
  for (const part of parts.slice(0, -1)) {
    const m = MODIFIERS[part.toLowerCase()];
    if (!m) throw new ToolError(`Unknown modifier "${part}" in "${spec}". Use ctrl, shift, alt or meta.`);
    modifiers |= m.bit;
  }
  const lower = last.toLowerCase();
  let def: KeyDef | undefined = NAMED_KEYS[lower];
  if (!def && MODIFIERS[lower]) {
    const m = MODIFIERS[lower];
    def = { key: m.key, code: m.code, vk: m.vk };
    modifiers |= m.bit;
  }
  const fn = /^f([1-9]|1[0-2])$/i.exec(last);
  if (!def && fn) def = { key: `F${fn[1]}`, code: `F${fn[1]}`, vk: 111 + Number(fn[1]) };
  if (!def) {
    if ([...last].length !== 1) throw new ToolError(`Unknown key "${last}". Use names like Enter, Tab, Escape, ArrowDown, PageDown, Backspace, F5, or a single character.`);
    const shifted = (modifiers & 8) !== 0;
    const ch = /[a-z]/i.test(last) ? (shifted ? last.toUpperCase() : last.toLowerCase()) : last;
    const upper = ch.toUpperCase();
    let code = '';
    if (/[a-z]/i.test(ch)) code = `Key${upper}`;
    else if (/[0-9]/.test(ch)) code = `Digit${ch}`;
    def = { key: ch, code, vk: upper.charCodeAt(0), text: ch };
  }
  const parsed: ParsedKey = { ...def, modifiers };
  if (modifiers & (1 | 2 | 4)) {
    delete parsed.text;
    const cmd = EDIT_COMMANDS[def.key.toLowerCase()];
    if (cmd && modifiers & (2 | 4)) parsed.commands = [cmd === 'undo' && modifiers & 8 ? 'redo' : cmd];
  }
  return parsed;
}

async function pressKey(session: BrowserSession, page: PageState, key: ParsedKey): Promise<void> {
  const common = {
    modifiers: key.modifiers,
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
  };
  const down = session.cmd(page, 'Input.dispatchKeyEvent', {
    ...common,
    type: key.text ? 'keyDown' : 'rawKeyDown',
    ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
    ...(key.commands ? { commands: key.commands } : {}),
  });
  const up = async () => {
    await down;
    await session.cmd(page, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  };
  await session.raceDialog(page, up());
}

// ---------------------------------------------------------------------------
// Screenshots

function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

const MAX_SHOT_WIDTH = 1280;
const MAX_SHOT_HEIGHT = 8000;

// ---------------------------------------------------------------------------
// Tools

/** Evaluates a snippet as an expression; falls back to an async function body for top-level await / return. */
async function evaluateSnippet(session: BrowserSession, page: PageState, code: string): Promise<unknown> {
  const opts = { allowDialog: true, timeoutMs: 30_000 };
  try {
    return await session.evaluate(page, code, opts);
  } catch (err) {
    if (!(err instanceof ToolError) || !/^SyntaxError.*(await|return|already been declared)/i.test(err.message)) throw err;
    for (const wrapped of [`(async () => (${code}\n))()`, `(async () => {\n${code}\n})()`]) {
      try {
        return await session.evaluate(page, wrapped, opts);
      } catch (inner) {
        if (!(inner instanceof ToolError) || !/^SyntaxError/.test(inner.message)) throw inner;
      }
    }
    throw err;
  }
}

export function createBrowserTools(session: BrowserSession): Tool[] {
  const dialogNote = (page: PageState): string[] => {
    const message = session.dialogMessage(page);
    return message ? [message] : [];
  };

  const navigateTool: Tool<{ url: string; new_tab?: boolean }> = {
    name: 'browser_navigate',
    label: 'Navigate',
    kind: 'read',
    description:
      'Open a URL in the browser (a real Chrome window with its own persistent profile) and wait for it to load. ' +
      'Accepts full URLs, bare domains ("example.com"), "localhost:3000", or plain search words (which run a Google search). ' +
      'Returns the page title, visible text and a numbered list of interactive elements, like browser_read. ' +
      'Use new_tab=true to keep the current tab.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL, domain, localhost:port, or search words.' },
        new_tab: { type: 'boolean', description: 'Open in a new tab instead of the current one.' },
      },
      required: ['url'],
    },
    summarize: (i) => i.url,
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const url = normalizeUrl(input.url);
      if (input.new_tab) await session.newTab();
      const page = await session.getPage();
      const result = await session.navigate(page, url, ctx.signal);
      throwIfAborted(ctx.signal);
      if (!result.dialog) await session.settle(page, ctx.signal, { quietMs: 200, capMs: 1500 });
      const notes: string[] = [];
      if (url !== input.url.trim()) notes.push(`Opened ${url}`);
      if (result.timedOut) notes.push('Note: the page had not finished loading after 30s; content may be incomplete.');
      return readPage(session, page, { maxChars: 4000, maxItems: 60 }, notes);
    },
  };

  const readTool: Tool<{ selector?: string; query?: string; max_chars?: number; max_items?: number }> = {
    name: 'browser_read',
    label: 'Read page',
    kind: 'read',
    description:
      'Read the current browser page: title, URL, visible text, then a numbered list of visible interactive elements ' +
      '"[n] role "name" (value=…, placeholder=…, checked, disabled, href=…)". Use the number n as `ref` in browser_click / browser_type / browser_scroll. ' +
      'Refs are reassigned on every read, so read again after the page changes. ' +
      'selector limits the text and elements to part of the page; query keeps only elements whose text matches. Open shadow DOM is included; iframe content is not.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to restrict the output to part of the page.' },
        query: { type: 'string', description: 'Only list interactive elements containing this text (case-insensitive).' },
        max_chars: { type: 'integer', description: 'Maximum characters of page text (default 8000).' },
        max_items: { type: 'integer', description: 'Maximum number of elements to list (default 150).' },
      },
    },
    summarize: (i) => i.selector || i.query || 'page',
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const page = await session.getPage();
      return readPage(session, page, { selector: input.selector, query: input.query, maxChars: input.max_chars, maxItems: input.max_items });
    },
  };

  const clickTool: Tool<Target & { double?: boolean; button?: 'left' | 'right' | 'middle' }> = {
    name: 'browser_click',
    label: 'Click',
    kind: 'interact',
    description:
      'Click an element on the page with real mouse events. Identify it by `ref` (the [n] from browser_read, preferred), a CSS `selector`, or visible `text`. ' +
      'The element is scrolled into view first. Waits for navigation and page updates, then reports the resulting page. ' +
      'Native <select> dropdowns cannot be clicked: use browser_type with the option text instead.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'Element number from the last browser_read.' },
        selector: { type: 'string', description: 'CSS selector (first visible match).' },
        text: { type: 'string', description: 'Visible text or label of the element.' },
        double: { type: 'boolean', description: 'Double-click.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      },
    },
    summarize: (i) => targetSummary(i) + (i.double ? ' (double)' : '') + (i.button && i.button !== 'left' ? ` (${i.button})` : ''),
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const target = pickTarget(input)!;
      const page = await session.getPage();
      blockingDialog(session, page);
      const before = await session.pageInfo(page);
      const tabsBefore = await snapshotTabs(session);
      const loc = await run<{ x: number; y: number; desc: string; covered: string }>(session, page, LOCATE_SCRIPT, { target, action: 'click' });
      const button = input.button ?? 'left';
      const mask = { left: 1, right: 2, middle: 4 }[button] ?? 1;
      const clicks = input.double ? 2 : 1;
      const dispatch = async () => {
        await session.cmd(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
        for (let n = 1; n <= clicks; n++) {
          await session.cmd(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button, buttons: mask, clickCount: n });
          await session.cmd(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button, buttons: 0, clickCount: n });
        }
      };
      const raced = await session.raceDialog(page, dispatch());
      if (!raced.dialog) await session.settle(page, ctx.signal);
      throwIfAborted(ctx.signal);
      const notes = [`${input.double ? 'Double-clicked' : button === 'left' ? 'Clicked' : `${button}-clicked`} ${loc.desc}.`];
      if (loc.covered) notes.push(`Warning: another element was on top at that point (${loc.covered}); the click may have hit it instead.`);
      return afterAction(session, page, before, tabsBefore, notes);
    },
  };

  const typeTool: Tool<{ text: string; ref?: number; selector?: string; clear?: boolean; submit?: boolean }> = {
    name: 'browser_type',
    label: 'Type',
    kind: 'interact',
    description:
      'Type text into an input, textarea or contenteditable element (identified by `ref` or `selector`), or into the focused element if neither is given. ' +
      'Existing content is replaced unless clear=false. Fires real input events so frameworks like React notice. ' +
      'For a <select> dropdown, pass the option text or value as `text` to choose it. submit=true presses Enter afterwards.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type (or the option to choose for a <select>).' },
        ref: { type: 'integer', description: 'Element number from the last browser_read.' },
        selector: { type: 'string', description: 'CSS selector of the field.' },
        clear: { type: 'boolean', description: 'Replace existing content (default true when a target is given).' },
        submit: { type: 'boolean', description: 'Press Enter after typing (submits forms, runs searches).' },
      },
      required: ['text'],
    },
    summarize: (i) => `${targetSummary(i) ? targetSummary(i) + ' ← ' : ''}${JSON.stringify(i.text.length > 60 ? i.text.slice(0, 57) + '…' : i.text)}${i.submit ? ' ⏎' : ''}`,
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      if (typeof input.text !== 'string') throw new ToolError('text is required.');
      const target = pickTarget(input, true);
      const page = await session.getPage();
      blockingDialog(session, page);
      const before = await session.pageInfo(page);
      const tabsBefore = await snapshotTabs(session);
      const clear = input.clear ?? !!target;
      const prep = await run<{ kind: 'text' | 'done'; desc: string; value?: string }>(session, page, PREPARE_TYPE_SCRIPT, { target, clear, text: input.text });
      const notes: string[] = [];
      if (prep.kind === 'done') {
        notes.push(`Set ${prep.desc} to "${prep.value ?? input.text}".`);
      } else {
        if (input.text.length > 0) await session.cmd(page, 'Input.insertText', { text: input.text });
        let readback = '';
        try {
          const active = await run<{ desc: string; value: string } | null>(session, page, ACTIVE_VALUE_SCRIPT);
          if (active) readback = ` The field now contains "${active.value}".`;
        } catch {
          // best effort
        }
        notes.push(`Typed ${input.text.length} characters into ${prep.desc}.${readback}`);
      }
      if (input.submit) {
        const raced = await session.raceDialog(page, pressKey(session, page, parseKey('Enter')));
        if (!raced.dialog) await session.settle(page, ctx.signal);
        notes.push('Pressed Enter.');
        return afterAction(session, page, before, tabsBefore, notes);
      }
      return [...notes, ...dialogNote(page)].join('\n');
    },
  };

  const pressTool: Tool<{ key: string }> = {
    name: 'browser_press',
    label: 'Press',
    kind: 'interact',
    description:
      'Press a key or key chord in the page (goes to the focused element). Examples: "Enter", "Tab", "Escape", "ArrowDown", "PageDown", "Backspace", "ctrl+a", "shift+Tab", "F5". ' +
      'Enter submits forms. Waits for any resulting navigation or page update.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name or chord such as "Enter" or "ctrl+a".' } },
      required: ['key'],
    },
    summarize: (i) => describeKey(i.key),
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const key = parseKey(input.key);
      const page = await session.getPage();
      blockingDialog(session, page);
      const before = await session.pageInfo(page);
      const tabsBefore = await snapshotTabs(session);
      const raced = await session.raceDialog(page, pressKey(session, page, key));
      if (!raced.dialog) await session.settle(page, ctx.signal);
      throwIfAborted(ctx.signal);
      return afterAction(session, page, before, tabsBefore, [`Pressed ${input.key}.`]);
    },
  };

  const scrollTool: Tool<{ direction: 'up' | 'down' | 'top' | 'bottom' | 'to_element'; pages?: number; ref?: number; selector?: string }> = {
    name: 'browser_scroll',
    label: 'Scroll',
    kind: 'read',
    description:
      'Scroll the page: "down"/"up" by `pages` viewport heights (default 1), "top"/"bottom", or "to_element" (give ref or selector). ' +
      'Useful to trigger lazy loading or to bring something into view before a screenshot. Reports the scroll position.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom', 'to_element'] },
        pages: { type: 'number', description: 'Viewport heights to scroll for up/down (default 1).' },
        ref: { type: 'integer', description: 'Element number from browser_read (for to_element).' },
        selector: { type: 'string', description: 'CSS selector (for to_element).' },
      },
      required: ['direction'],
    },
    summarize: (i) => (i.direction === 'to_element' ? `to ${targetSummary(i) || 'element'}` : i.direction + (i.pages ? ` ${i.pages}` : '')),
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const page = await session.getPage();
      blockingDialog(session, page);
      let info: { y: number; max: number; vh: number; vw: number };
      let what: string;
      switch (input.direction) {
        case 'top':
        case 'bottom':
          info = await run(session, page, SCROLL_SCRIPT, { to: input.direction });
          what = `Scrolled to the ${input.direction}.`;
          break;
        case 'to_element': {
          const target = pickTarget(input)!;
          const loc = await run<{ desc: string }>(session, page, LOCATE_SCRIPT, { target, action: 'scroll' });
          info = await run(session, page, INFO_SCRIPT);
          what = `Scrolled ${loc.desc} into view.`;
          break;
        }
        case 'up':
        case 'down': {
          const start = await run<{ y: number; max: number; vh: number; vw: number }>(session, page, INFO_SCRIPT);
          const pages = Math.min(Math.max(Number(input.pages ?? 1) || 1, 0.1), 50);
          const sign = input.direction === 'down' ? 1 : -1;
          const deltaY = sign * Math.round(start.vh * pages * 0.9);
          try {
            await session.cmd(page, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(start.vw / 2), y: Math.round(start.vh / 2), deltaX: 0, deltaY }, 3000);
          } catch {
            // A hidden or minimised browser window never processes input events; scroll from script instead.
            await run(session, page, 'window.scrollBy(0, A.deltaY); return true;', { deltaY });
          }
          await sleep(350, ctx.signal);
          info = await run(session, page, INFO_SCRIPT);
          what = info.y === start.y ? `The page did not scroll ${input.direction} (already at the ${input.direction === 'down' ? 'bottom' : 'top'}, or the content scrolls inside an inner container).` : `Scrolled ${input.direction}.`;
          break;
        }
        default:
          throw new ToolError('direction must be one of up, down, top, bottom, to_element.');
      }
      return `${what} Position ${info.y} of ${info.max}px (viewport ${info.vh}px high).`;
    },
  };

  const waitTool: Tool<{ for: 'text' | 'selector' | 'url' | 'load' | 'idle' | 'seconds'; value?: string; seconds?: number; timeout_s?: number }> = {
    name: 'browser_wait',
    label: 'Wait',
    kind: 'read',
    description:
      'Wait for something on the page. for="text" (value = text that must appear), "selector" (value = CSS selector present), "url" (value = substring of the URL), ' +
      '"load" (page finished loading), "idle" (DOM stops changing for 1s), or "seconds" (plain pause, `seconds` up to 60). ' +
      'Fails with a timeout error after timeout_s (default 20).',
    parameters: {
      type: 'object',
      properties: {
        for: { type: 'string', enum: ['text', 'selector', 'url', 'load', 'idle', 'seconds'] },
        value: { type: 'string', description: 'Text, CSS selector or URL fragment to wait for.' },
        seconds: { type: 'number', description: 'Seconds to pause when for="seconds".' },
        timeout_s: { type: 'number', description: 'Give up after this many seconds (default 20, max 120).' },
      },
      required: ['for'],
    },
    summarize: (i) => (i.for === 'seconds' ? `${i.seconds ?? i.value ?? 1}s` : i.value ? `${i.for}: ${i.value}` : i.for),
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const started = Date.now();
      const timeout = Math.min(Math.max(Number(input.timeout_s ?? 20) || 20, 1), 120) * 1000;
      const page = await session.getPage();
      const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
      const done = async (what: string) => {
        const info = await session.pageInfo(page);
        return `${what} after ${elapsed()}. Page: "${info.title || '(untitled)'}" ${info.url}`;
      };

      if (input.for === 'seconds') {
        const secs = Math.min(Math.max(Number(input.seconds ?? input.value ?? 1) || 1, 0), 60);
        await sleep(secs * 1000, ctx.signal);
        throwIfAborted(ctx.signal);
        return `Waited ${secs}s.`;
      }
      if (input.for === 'load') {
        const r = await session.waitForLoad(page, timeout, ctx.signal);
        if (r.timedOut) throw new ToolError(`The page had not finished loading after ${timeout / 1000}s.`);
        return done('Page loaded');
      }
      if (input.for === 'idle') {
        await session.settle(page, ctx.signal, { quietMs: 1000, capMs: timeout });
        return done('Page is idle');
      }
      if (!input.value) throw new ToolError(`value is required for for="${input.for}".`);
      const condition = {
        text: `(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(input.value.toLowerCase())})`,
        selector: `!!document.querySelector(${JSON.stringify(input.value)})`,
        url: `location.href.includes(${JSON.stringify(input.value)})`,
      }[input.for as 'text' | 'selector' | 'url'];
      if (!condition) throw new ToolError('for must be one of text, selector, url, load, idle, seconds.');
      while (Date.now() - started < timeout) {
        throwIfAborted(ctx.signal);
        if (await session.evaluate<boolean>(page, condition, { timeoutMs: 10_000 })) return done(`Condition met (${input.for} ${JSON.stringify(input.value)})`);
        await sleep(250, ctx.signal);
      }
      throwIfAborted(ctx.signal);
      throw new ToolError(`Timed out after ${timeout / 1000}s waiting for ${input.for} ${JSON.stringify(input.value)}. Call browser_read or browser_screenshot to see the current state.`);
    },
  };

  const screenshotTool: Tool<{ full_page?: boolean }> = {
    name: 'browser_screenshot',
    label: 'Screenshot',
    kind: 'read',
    description:
      'Take a screenshot of the current browser tab (JPEG, max 1280px wide) so you can see layout, images and visual state. ' +
      'Prefer browser_read for text and controls; use this to verify how the page looks. full_page=true captures the whole scrollable page.',
    parameters: {
      type: 'object',
      properties: { full_page: { type: 'boolean', description: 'Capture the full scrollable page instead of just the viewport.' } },
    },
    summarize: (i) => (i.full_page ? 'full page' : 'viewport'),
    async execute(input, ctx): Promise<ToolResult> {
      throwIfAborted(ctx.signal);
      const page = await session.getPage();
      blockingDialog(session, page);
      const info = await session.pageInfo(page);
      const metrics = await session.cmd(page, 'Page.getLayoutMetrics');
      const dpr = (await session.evaluate<number>(page, 'window.devicePixelRatio || 1', { timeoutMs: 5000 })) || 1;
      const vp = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
      const content = metrics.cssContentSize ?? metrics.contentSize ?? { width: vp.clientWidth, height: vp.clientHeight };
      const full = !!input.full_page;
      const width = full ? content.width : vp.clientWidth;
      const height = full ? Math.min(content.height, 16_000) : vp.clientHeight;
      const scale = Math.min(1, MAX_SHOT_WIDTH / (width * dpr), MAX_SHOT_HEIGHT / (height * dpr));
      const params: Record<string, unknown> = { format: 'jpeg', quality: 80, captureBeyondViewport: full, fromSurface: true };
      // always clip: the unclipped viewport shot includes the scrollbar and ignores our width cap
      params.clip = { x: full ? 0 : vp.pageX ?? 0, y: full ? 0 : vp.pageY ?? 0, width, height, scale };
      let shot: { data: string };
      try {
        shot = await session.cmd(page, 'Page.captureScreenshot', params, 20_000);
      } catch (err) {
        if (err instanceof CdpError && /timed out/.test(err.message)) {
          throw new ToolError('The screenshot timed out. The browser window may be minimized or the tab hidden; call browser_tabs with action "switch" to bring this tab forward.');
        }
        throw err;
      }
      const size = jpegSize(Buffer.from(shot.data, 'base64'));
      const dims = size ? `${size.width}×${size.height}` : `${Math.round(width * scale * dpr)}×${Math.round(height * scale * dpr)}`;
      const notes = full && content.height > 16_000 ? ' (page truncated at 16000px)' : '';
      return {
        text: `Screenshot of "${info.title || '(untitled)'}" (${info.url}), ${dims}${notes}`,
        images: [{ mime: 'image/jpeg', data: shot.data }],
      };
    },
  };

  const consoleTool: Tool<{ clear?: boolean; all?: boolean }> = {
    name: 'browser_console',
    label: 'Console',
    kind: 'read',
    description:
      'Show what the current tab logged since it was opened (last 200 events): console errors/warnings, uncaught exceptions, failed network requests and HTTP responses with status >= 400. ' +
      'all=true also includes console.log/info/debug. clear=true empties the buffer afterwards. Use it when testing web apps.',
    parameters: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
        all: { type: 'boolean', description: 'Include log/info/debug messages too.' },
      },
    },
    summarize: (i) => (i.all ? 'all messages' : 'errors') + (i.clear ? ' (clear)' : ''),
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const page = await session.getPage();
      const entries = session.getLogs(page);
      const shown = entries.filter((e) => input.all || e.level === 'error' || e.level === 'warn' || e.level === 'exception' || e.level === 'network');
      if (input.clear) session.clearLogs(page);
      if (!shown.length) return input.all ? '(no console output)' : '(no errors, warnings or failed requests)';
      const lines = shown.map((e) => {
        const time = new Date(e.time).toTimeString().slice(0, 8);
        const where = e.location ? `  at ${e.location}` : '';
        return `${time} [${e.level}] ${e.text}${where}`;
      });
      return truncateMiddle(lines.join('\n'), 15_000);
    },
  };

  const evalTool: Tool<{ code: string }> = {
    name: 'browser_eval',
    label: 'Evaluate',
    kind: 'interact',
    description:
      'Run JavaScript in the current page and return the result as JSON (promises are awaited; top-level await works). ' +
      'The value of the last expression is returned; "return …" also works. Return plain data (strings, numbers, objects), not DOM nodes. ' +
      'Use it to read app state or extract data that browser_read does not show.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript to evaluate in the page.' } },
      required: ['code'],
    },
    summarize: (i) => i.code.replace(/\s+/g, ' ').slice(0, 100),
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      if (!input.code?.trim()) throw new ToolError('code is empty.');
      const page = await session.getPage();
      let value: unknown;
      try {
        value = await abortable(evaluateSnippet(session, page, input.code), ctx.signal);
      } catch (err) {
        if (err instanceof CdpError && /(by value|reference chain)/i.test(err.message)) {
          throw new ToolError('The result cannot be serialized to JSON (DOM node, circular object, …). Return plain data, e.g. el.outerHTML or JSON.stringify(...).');
        }
        if (err instanceof ToolError && !/dialog/.test(err.message)) throw new ToolError(`Script error: ${err.message}`);
        throw err;
      }
      const text = value === undefined ? 'undefined' : (JSON.stringify(value, null, 2) ?? String(value));
      return truncateMiddle(text, 10_000);
    },
  };

  const tabsTool: Tool<{ action?: 'list' | 'new' | 'switch' | 'close'; tab?: number | string; url?: string }> = {
    name: 'browser_tabs',
    label: 'Tabs',
    kind: 'read',
    description:
      'Manage browser tabs. action "list" (default) shows numbered tabs; "new" opens a tab (optionally with url) and makes it current; ' +
      '"switch" makes tab `tab` current (its number, or text from its URL/title); "close" closes `tab` (default: the current one). ' +
      'All other browser tools act on the current tab. If the user closes a tab, another one is picked automatically.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] },
        tab: { type: 'string', description: 'Tab number as shown by "list" (e.g. "2"), or text from its URL or title.' },
        url: { type: 'string', description: 'URL to open for action "new".' },
      },
    },
    summarize: (i) => `${i.action ?? 'list'}${i.tab !== undefined ? ` ${i.tab}` : ''}${i.url ? ` ${i.url}` : ''}`,
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      const action = input.action ?? 'list';
      switch (action) {
        case 'list':
          return formatTabs(await session.listTabs());
        case 'new': {
          await session.newTab();
          if (input.url) {
            const page = await session.getPage();
            const result = await session.navigate(page, normalizeUrl(input.url), ctx.signal);
            if (!result.dialog) await session.settle(page, ctx.signal, { quietMs: 200, capMs: 1500 });
            const notes = result.timedOut ? ['Note: the page had not finished loading after 30s.'] : [];
            return `${await readPage(session, page, { maxChars: 3000, maxItems: 50 }, notes)}\n\n${formatTabs(await session.listTabs())}`;
          }
          return `Opened a new blank tab.\n${formatTabs(await session.listTabs())}`;
        }
        case 'switch': {
          if (input.tab === undefined || input.tab === '') throw new ToolError('tab is required for action "switch".');
          const tab = await session.switchTab(input.tab);
          const page = await session.getPage();
          const body = await readPage(session, page, { maxChars: 3000, maxItems: 50 }, [`Switched to tab ${tab.index}.`]);
          return `${body}\n\n${formatTabs(await session.listTabs())}`;
        }
        case 'close': {
          const tab = await session.closeTab(input.tab);
          return `Closed tab ${tab.index} "${tab.title || '(untitled)'}".\n${formatTabs(await session.listTabs())}`;
        }
        default:
          throw new ToolError('action must be one of list, new, switch, close.');
      }
    },
  };

  const dialogTool: Tool<{ action: 'accept' | 'dismiss'; text?: string }> = {
    name: 'browser_dialog',
    label: 'Dialog',
    kind: 'interact',
    description:
      'Handle a JavaScript dialog (alert, confirm, prompt, beforeunload) that is open in the current tab. ' +
      'While a dialog is open the page is blocked and other browser tools fail with a message pointing here. ' +
      'action "accept" (OK) or "dismiss" (Cancel); for prompt dialogs `text` is the answer.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss'] },
        text: { type: 'string', description: 'Text to enter for prompt() dialogs when accepting.' },
      },
      required: ['action'],
    },
    summarize: (i) => i.action + (i.text ? ` "${i.text}"` : ''),
    async execute(input, ctx) {
      throwIfAborted(ctx.signal);
      if (input.action !== 'accept' && input.action !== 'dismiss') throw new ToolError('action must be "accept" or "dismiss".');
      const page = await session.getPage();
      const dialog = page.dialog;
      if (!dialog) throw new ToolError('No JavaScript dialog is open in the current tab.');
      await session.cmd(page, 'Page.handleJavaScriptDialog', { accept: input.action === 'accept', ...(input.text !== undefined ? { promptText: input.text } : {}) }, 10_000);
      page.dialog = undefined;
      await sleep(150, ctx.signal);
      if (page.loading) await session.waitForLoad(page, 10_000, ctx.signal);
      const again = session.dialogMessage(page);
      return `${input.action === 'accept' ? 'Accepted' : 'Dismissed'} the ${dialog.type} dialog "${dialog.message}".${again ? `\nAnother dialog opened: ${again}` : ''}`;
    },
  };

  return [navigateTool, readTool, clickTool, typeTool, pressTool, scrollTool, waitTool, screenshotTool, consoleTool, evalTool, tabsTool, dialogTool] as Tool[];
}

