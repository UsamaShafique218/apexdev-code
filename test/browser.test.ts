import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserSession, findBrowserExecutable } from '../src/browser/session';
import { createBrowserTools, normalizeUrl, parseKey } from '../src/tools/browser';
import { BackgroundProcesses, detectShell } from '../src/tools/shell';
import { Tool, ToolContext, ToolResult } from '../src/tools/types';

const PAGE = `<!doctype html><html><head><title>Test Page</title></head><body>
<h1>Welcome</h1>
<label for="name">Your name</label>
<input id="name" placeholder="Name here">
<button id="greet" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
<div id="out"></div>
<form action="/search" method="get"><input name="q" placeholder="Search"><input type="submit" value="Go"></form>
<button onclick="console.error('boom'); fetch('/missing').catch(() => {})">Break</button>
<button onclick="alert('hi there'); document.title = 'after alert'">Alert</button>
<button onclick="setTimeout(() => { document.getElementById('late').textContent = 'Loaded later' }, 500)">Later</button>
<div id="late"></div>
<label for="color">Colour</label><select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<a href="/other">Other page</a>
</body></html>`;

let server: http.Server;
let baseUrl: string;
let profileDir: string;
let session: BrowserSession;
let tools: Record<string, Tool>;
let ctx: ToolContext;
const executable = findBrowserExecutable();
const skip = executable ? false : 'no Chrome/Edge installation found';

function textOf(result: string | ToolResult): string {
  return typeof result === 'string' ? result : result.text;
}

async function call(name: string, input: Record<string, unknown> = {}): Promise<string> {
  return textOf(await tools[name].execute(input, ctx));
}

/** Finds the [ref] of the first listed element whose line contains `fragment`. */
function refOf(readOutput: string, fragment: string): number {
  const line = readOutput.split('\n').find((l) => /^\[\d+\]/.test(l) && l.includes(fragment));
  assert.ok(line, `no element containing ${fragment} in:\n${readOutput}`);
  return Number(/^\[(\d+)\]/.exec(line)![1]);
}

/** Command lines of running browser processes that use the given profile directory. */
function browserProcessesUsing(dir: string): string[] {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*apexdev-browser-test*' } | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', timeout: 30_000 })
        : execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter((l) => l.includes(path.basename(dir)));
  } catch {
    return [];
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    } else if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Results</title><h1>Results for ${url.searchParams.get('q')}</h1>`);
    } else if (url.pathname === '/other') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Other</title><p>The other page</p>');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (skip) return;
  profileDir = mkdtempSync(path.join(os.tmpdir(), 'apexdev-browser-test-'));
  session = new BrowserSession({ profileDir, headless: () => true });
  tools = Object.fromEntries(createBrowserTools(session).map((t) => [t.name, t]));
  ctx = { cwd: process.cwd(), signal: new AbortController().signal, shell: detectShell(), background: new BackgroundProcesses(), readFiles: new Set() };
});

after(async () => {
  await session?.dispose();
  server?.close();
  server?.closeAllConnections?.();
  if (profileDir) {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    assert.deepEqual(browserProcessesUsing(profileDir), [], 'browser processes left running');
  }
});

describe('helpers', () => {
  it('normalizes URLs and search words', () => {
    assert.equal(normalizeUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(normalizeUrl('example.com'), 'https://example.com');
    assert.equal(normalizeUrl('example.com/path?x=1'), 'https://example.com/path?x=1');
    assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
    assert.equal(normalizeUrl('localhost:3000/app'), 'http://localhost:3000/app');
    assert.equal(normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.equal(normalizeUrl('localhost'), 'http://localhost');
    assert.equal(normalizeUrl('about:blank'), 'about:blank');
    assert.equal(normalizeUrl('file:///C:/x.html'), 'file:///C:/x.html');
    assert.equal(normalizeUrl('best pizza near me'), 'https://www.google.com/search?q=best%20pizza%20near%20me');
    assert.equal(normalizeUrl('typescript'), 'https://www.google.com/search?q=typescript');
    assert.throws(() => normalizeUrl('javascript:alert(1)'), /not supported/);
    assert.throws(() => normalizeUrl('  '), /empty/);
  });

  it('parses keys and chords', () => {
    const enter = parseKey('Enter');
    assert.equal(enter.text, '\r');
    assert.equal(enter.vk, 13);
    const selectAll = parseKey('ctrl+a');
    assert.equal(selectAll.modifiers, 2);
    assert.deepEqual(selectAll.commands, ['selectAll']);
    assert.equal(selectAll.text, undefined);
    const back = parseKey('shift+Tab');
    assert.equal(back.modifiers, 8);
    assert.equal(back.key, 'Tab');
    assert.equal(parseKey('PageDown').vk, 34);
    assert.equal(parseKey('a').text, 'a');
    assert.throws(() => parseKey('Bogus'), /Unknown key/);
  });

  it('exposes the expected tools', () => {
    const list = createBrowserTools(new BrowserSession({ profileDir: os.tmpdir() }));
    const kinds = Object.fromEntries(list.map((t) => [t.name, t.kind]));
    assert.deepEqual(kinds, {
      browser_navigate: 'read',
      browser_read: 'read',
      browser_click: 'interact',
      browser_type: 'interact',
      browser_press: 'interact',
      browser_scroll: 'read',
      browser_wait: 'read',
      browser_screenshot: 'read',
      browser_console: 'read',
      browser_eval: 'interact',
      browser_tabs: 'read',
      browser_dialog: 'interact',
    });
  });
});

describe('browser tools', { skip, timeout: 240_000 }, () => {
  it('navigates and lists interactive elements with refs', async () => {
    const out = await call('browser_navigate', { url: baseUrl });
    assert.match(out, /Page: Test Page/);
    assert.match(out, /Welcome/);
    assert.match(out, /textbox "Your name" \(placeholder="Name here"\)/);
    assert.match(out, /button "Greet"/);
    assert.match(out, /link "Other page" \(href=\/other\)/);
    assert.match(out, /combobox "Colour" \(value="Red"\)/);
    refOf(out, 'button "Greet"');
  });

  it('read supports selector and query filters', async () => {
    const out = await call('browser_read', { query: 'greet' });
    assert.match(out, /\[1\] button "Greet"/);
    assert.doesNotMatch(out, /link "Other page"/);
    const part = await call('browser_read', { selector: 'h1' });
    assert.match(part, /--- Text of "h1" ---\nWelcome/);
    await assert.rejects(call('browser_read', { selector: '#nope' }), /No element matches/);
  });

  it('types into an input and clicks a button', async () => {
    const read = await call('browser_read');
    const input = refOf(read, 'textbox "Your name"');
    const button = refOf(read, 'button "Greet"');
    const typed = await call('browser_type', { ref: input, text: 'Ada' });
    assert.match(typed, /Typed 3 characters/);
    assert.match(typed, /now contains "Ada"/);
    const clicked = await call('browser_click', { ref: button });
    assert.match(clicked, /Clicked \[\d+\] button "Greet"/);
    assert.match(await call('browser_read', { selector: '#out' }), /Hello, Ada/);
    await call('browser_wait', { for: 'text', value: 'hello, ada', timeout_s: 5 });
    // typing again replaces the old value
    await call('browser_type', { selector: '#name', text: 'Grace' });
    await call('browser_click', { text: 'Greet' });
    assert.match(await call('browser_read', { selector: '#out' }), /Hello, Grace/);
  });

  it('chooses an option in a select', async () => {
    const out = await call('browser_type', { selector: '#color', text: 'Green' });
    assert.match(out, /Set .* to "Green"/);
    assert.equal(await call('browser_eval', { code: "document.getElementById('color').value" }), '"g"');
  });

  it('press Enter submits a form', async () => {
    await call('browser_type', { selector: 'input[name=q]', text: 'cdp rocks' });
    const out = await call('browser_press', { key: 'Enter' });
    assert.match(out, /Page: "Results"/);
    assert.match(out, /URL changed/);
    assert.match(await call('browser_read'), /Results for cdp rocks/);
  });

  it('click follows links and reports the URL change', async () => {
    await call('browser_navigate', { url: baseUrl });
    const out = await call('browser_click', { text: 'Other page' });
    assert.match(out, /Page: "Other"/);
    assert.match(out, /URL changed/);
  });

  it('waits for text that appears later and times out otherwise', async () => {
    await call('browser_navigate', { url: baseUrl });
    await call('browser_click', { text: 'Later' });
    const out = await call('browser_wait', { for: 'text', value: 'Loaded later', timeout_s: 10 });
    assert.match(out, /Condition met/);
    await assert.rejects(call('browser_wait', { for: 'text', value: 'never appears', timeout_s: 1 }), /Timed out/);
    assert.match(await call('browser_wait', { for: 'selector', value: '#late' }), /Condition met/);
    assert.match(await call('browser_wait', { for: 'url', value: '127.0.0.1' }), /Condition met/);
    assert.match(await call('browser_wait', { for: 'load' }), /Page loaded/);
    assert.match(await call('browser_wait', { for: 'idle' }), /idle/);
    assert.match(await call('browser_wait', { for: 'seconds', seconds: 0.2 }), /Waited/);
  });

  it('wait respects cancellation', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = tools.browser_wait.execute({ for: 'text', value: 'never', timeout_s: 30 }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(pending, /Cancelled/);
    assert.ok(Date.now() - started < 5000);
  });

  it('captures console errors and failed requests', async () => {
    await call('browser_navigate', { url: baseUrl });
    await call('browser_console', { clear: true });
    await call('browser_click', { text: 'Break' });
    await call('browser_wait', { for: 'seconds', seconds: 0.5 });
    const out = await call('browser_console');
    assert.match(out, /\[error\] boom/);
    assert.match(out, /\[network\] 404 GET .*\/missing/);
    await call('browser_eval', { code: "console.log('just a log'); setTimeout(() => { throw new Error('late failure') }, 0)" });
    await call('browser_wait', { for: 'seconds', seconds: 0.3 });
    const quiet = await call('browser_console');
    assert.doesNotMatch(quiet, /just a log/);
    assert.match(quiet, /\[exception\] .*late failure/);
    assert.match(await call('browser_console', { all: true, clear: true }), /just a log/);
    assert.match(await call('browser_console'), /no errors/);
  });

  it('takes a JPEG screenshot', async () => {
    const result = (await tools.browser_screenshot.execute({}, ctx)) as ToolResult;
    assert.equal(result.images?.length, 1);
    assert.equal(result.images![0].mime, 'image/jpeg');
    const bytes = Buffer.from(result.images![0].data, 'base64');
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.match(result.text, /^Screenshot of "Test Page" \(http:\/\/127\.0\.0\.1:\d+\/\), \d+×\d+$/);
    assert.ok(Number(/, (\d+)×\d+$/.exec(result.text)![1]) <= 1280);
    const full = (await tools.browser_screenshot.execute({ full_page: true }, ctx)) as ToolResult;
    assert.equal(Buffer.from(full.images![0].data, 'base64')[0], 0xff);
  });

  it('scrolls the page', async () => {
    await call('browser_eval', { code: "document.body.style.minHeight = '5000px'" });
    assert.match(await call('browser_scroll', { direction: 'down' }), /Scrolled down\. Position [1-9]\d* of/);
    assert.match(await call('browser_scroll', { direction: 'bottom' }), /to the bottom/);
    assert.match(await call('browser_scroll', { direction: 'top' }), /Position 0 of/);
    assert.match(await call('browser_scroll', { direction: 'to_element', selector: 'a' }), /into view/);
  });

  it('evaluates JavaScript', async () => {
    assert.equal(await call('browser_eval', { code: '1 + 2' }), '3');
    assert.equal(await call('browser_eval', { code: 'await Promise.resolve({ a: [1, 2] })' }), JSON.stringify({ a: [1, 2] }, null, 2));
    assert.equal(await call('browser_eval', { code: 'return document.title' }), '"Test Page"');
    assert.equal(await call('browser_eval', { code: 'undefined' }), 'undefined');
    await assert.rejects(call('browser_eval', { code: 'nope.nothing()' }), /ReferenceError/);
  });

  it('manages tabs: new, list, switch, close', async () => {
    const created = await call('browser_tabs', { action: 'new', url: `${baseUrl}/other` });
    assert.match(created, /The other page/);
    let list = await call('browser_tabs');
    assert.match(list, /\* 2\. Other/);
    assert.match(list, / {2}1\. Test Page/);
    const switched = await call('browser_tabs', { action: 'switch', tab: 1 });
    assert.match(switched, /Switched to tab 1/);
    assert.match(await call('browser_read'), /Page: Test Page/);
    assert.match(await call('browser_tabs', { action: 'switch', tab: 'other' }), /The other page/);
    const closed = await call('browser_tabs', { action: 'close' });
    assert.match(closed, /Closed tab 2/);
    list = await call('browser_tabs');
    assert.match(list, /\* 1\. Test Page/);
    assert.doesNotMatch(list, /2\./);
    await assert.rejects(call('browser_tabs', { action: 'switch', tab: 9 }), /no tab 9/);
  });

  it('reports a JavaScript alert and handles it with browser_dialog', async () => {
    await call('browser_navigate', { url: baseUrl });
    const clicked = await call('browser_click', { text: 'Alert' });
    assert.match(clicked, /A JavaScript alert dialog is open: "hi there"/);
    assert.match(clicked, /browser_dialog/);
    assert.match(await call('browser_read'), /dialog is open/);
    await assert.rejects(call('browser_eval', { code: '1' }), /browser_dialog/);
    await assert.rejects(call('browser_click', { text: 'Greet' }), /browser_dialog/);
    const handled = await call('browser_dialog', { action: 'accept' });
    assert.match(handled, /Accepted the alert dialog "hi there"/);
    await assert.rejects(call('browser_dialog', { action: 'accept' }), /No JavaScript dialog/);
    await call('browser_wait', { for: 'selector', value: 'button' });
    assert.equal(await call('browser_eval', { code: 'document.title' }), '"after alert"');
  });

  it('handles confirm/prompt answers', async () => {
    const evalPromise = call('browser_eval', { code: "window.__answer = prompt('Your age?', '30'); 1" });
    // the eval returns as soon as the dialog opens
    await assert.rejects(evalPromise, /prompt dialog is open/);
    await call('browser_dialog', { action: 'accept', text: '42' });
    assert.equal(await call('browser_eval', { code: 'window.__answer' }), '"42"');
  });

  it('survives the current tab being closed by someone else', async () => {
    await call('browser_tabs', { action: 'new', url: `${baseUrl}/other` });
    const page = await session.getPage();
    await session.cmd(page, 'Page.close');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const out = await call('browser_read');
    assert.match(out, /Page: (Test Page|after alert)/);
  });

  it('relaunches after the browser was closed', async () => {
    const page = await session.getPage();
    const client = (session as any).client;
    await session.cmd(page, 'Browser.close').catch(() => undefined);
    for (let i = 0; i < 50 && !client.closed; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const out = await call('browser_navigate', { url: `${baseUrl}/other` });
    assert.match(out, /The other page/);
  });
});
