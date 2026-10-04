import { ChildProcess, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { ToolError, throwIfAborted } from '../tools/types';
import { CdpClient, CdpError } from './cdp';

export interface BrowserSessionOptions {
  /** Directory for the dedicated browser profile (cookies and logins persist here). */
  profileDir: string;
  /** Custom browser executable; falls back to auto-detected Chrome, then Edge. */
  executablePath?: () => string | undefined;
  headless?: () => boolean;
}

export interface ConsoleEntry {
  time: number;
  level: 'log' | 'info' | 'debug' | 'warn' | 'error' | 'exception' | 'network';
  text: string;
  location?: string;
}

export interface PendingDialog {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
}

export interface TabInfo {
  /** 1-based tab number, as shown to the model. */
  index: number;
  targetId: string;
  title: string;
  url: string;
  current: boolean;
}

/** Everything we track about an attached tab. */
export class PageState {
  sessionId?: string;
  attaching?: Promise<void>;
  mainFrameId?: string;
  loading = false;
  dialog?: PendingDialog;
  readonly logs: ConsoleEntry[] = [];
  readonly requests = new Map<string, { method: string; url: string }>();
  readonly dialogWaiters = new Set<() => void>();
  constructor(readonly targetId: string) {}
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

const LOG_LIMIT = 200;
const LOAD_TIMEOUT = 30_000;

export const DIALOG_HINT = 'Use browser_dialog (accept or dismiss) to handle it first.';

export function findBrowserExecutable(custom?: string): string | undefined {
  if (custom && existsSync(custom)) return custom;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const root of roots) candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const root of roots) candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      for (const name of names) candidates.push(path.join(dir, name));
    }
  }
  return candidates.find((c) => existsSync(c));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });
}

/** Resolves with the promise result, or rejects early when the signal aborts. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ToolError('Cancelled by the user.'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const PAGE_EVENTS = [
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
  'Network.loadingFinished',
  'Log.entryAdded',
  'Page.javascriptDialogOpening',
  'Page.javascriptDialogClosed',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
  'Page.frameNavigated',
  'Page.loadEventFired',
];

/** Waits (briefly) for a child process to exit. */
function waitExit(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      child.removeListener('exit', done);
      resolve();
    }
    child.once('exit', done);
  });
}

function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => resolve());
      killer.on('exit', () => resolve());
    });
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  return Promise.resolve();
}

/** A real Chrome/Edge window driven over CDP: tabs, console capture, dialogs, navigation helpers. */
export class BrowserSession {
  private client?: CdpClient;
  private connecting?: Promise<CdpClient>;
  private child?: ChildProcess;
  private readonly targets = new Map<string, TargetInfo>();
  private readonly pages = new Map<string, PageState>();
  private readonly bySession = new Map<string, PageState>();
  private currentId?: string;

  constructor(private readonly opts: BrowserSessionOptions) {}

  // ---------------------------------------------------------------- connection

  private async ensureClient(): Promise<CdpClient> {
    if (this.client && !this.client.closed) return this.client;
    this.connecting ??= this.connectOrLaunch().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOrLaunch(): Promise<CdpClient> {
    this.resetState();
    let client = await this.tryReuse();
    if (!client) {
      // an old instance may still be shutting down (the user just closed it)
      if (this.child) await waitExit(this.child, 5000);
      client = await this.launch();
    }
    this.client = client;
    for (const method of PAGE_EVENTS) client.on(method, (params, sid) => this.onPageEvent(method, params, sid));
    client.on('Target.targetCreated', (p) => this.upsertTarget(p.targetInfo));
    client.on('Target.targetInfoChanged', (p) => this.upsertTarget(p.targetInfo));
    client.on('Target.targetDestroyed', (p) => this.removeTarget(p.targetId));
    client.on('Target.detachedFromTarget', (p) => this.onDetached(p.sessionId));
    client.onClose(() => {
      if (this.client === client) {
        this.client = undefined;
        this.resetState();
      }
    });
    await client.send('Target.setDiscoverTargets', { discover: true });
    await this.refreshTargets(client);
    return client;
  }

  private resetState(): void {
    this.targets.clear();
    this.pages.clear();
    this.bySession.clear();
    this.currentId = undefined;
  }

  private portFile(): string {
    return path.join(this.opts.profileDir, 'DevToolsActivePort');
  }

  private async readPortFile(): Promise<string | undefined> {
    try {
      const [port, wsPath] = (await fs.readFile(this.portFile(), 'utf8')).split(/\r?\n/);
      if (!port || !wsPath) return undefined;
      return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      return undefined;
    }
  }

  /** Connects to a browser from an earlier run that still owns this profile. */
  private async tryReuse(): Promise<CdpClient | undefined> {
    const url = await this.readPortFile();
    if (!url) return undefined;
    try {
      return await CdpClient.connect(url, 2000);
    } catch {
      return undefined;
    }
  }

  private async launch(): Promise<CdpClient> {
    const custom = this.opts.executablePath?.();
    const exe = findBrowserExecutable(custom);
    if (!exe) {
      throw new ToolError(
        custom
          ? `Browser executable not found: ${custom}`
          : 'No Chrome or Edge installation was found. Install Google Chrome or Microsoft Edge, or set the browser executable path in the settings.',
      );
    }
    await fs.mkdir(this.opts.profileDir, { recursive: true });
    await fs.rm(this.portFile(), { force: true });
    const headless = this.opts.headless?.() ?? false;
    const args = [
      `--user-data-dir=${this.opts.profileDir}`,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      // The window usually sits behind VS Code; without these Chrome stops rendering it and
      // input events / evaluate calls hang until it is brought to the front.
      '--disable-features=Translate,CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ];
    if (headless) args.push('--headless=new', '--window-size=1280,900');
    args.push('about:blank');

    const child = spawn(exe, args, { stdio: 'ignore' });
    let spawnError: Error | undefined;
    child.on('error', (err) => (spawnError = err));
    this.child = child;

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (spawnError) throw new ToolError(`Could not start the browser (${exe}): ${spawnError.message}`);
      const url = await this.readPortFile();
      if (url) {
        try {
          return await CdpClient.connect(url, 5000);
        } catch {
          // the port file can appear a moment before the socket accepts connections
        }
      }
      if (child.exitCode !== null) {
        // the profile may be owned by another running instance; try to attach to it
        const reused = await this.tryReuse();
        if (reused) return reused;
        throw new ToolError(`The browser exited right after starting (exit code ${child.exitCode}). Is another browser window using the same profile?`);
      }
      await sleep(100);
    }
    await killTree(child);
    throw new ToolError('Timed out waiting for the browser to start.');
  }

  // ------------------------------------------------------------------- targets

  private upsertTarget(info: TargetInfo | undefined): void {
    if (!info || info.type !== 'page' || info.url.startsWith('devtools://')) return;
    const existing = this.targets.get(info.targetId);
    if (existing) {
      existing.title = info.title;
      existing.url = info.url;
    } else {
      this.targets.set(info.targetId, { targetId: info.targetId, type: info.type, title: info.title, url: info.url });
    }
  }

  private removeTarget(targetId: string): void {
    this.targets.delete(targetId);
    const page = this.pages.get(targetId);
    if (page?.sessionId) this.bySession.delete(page.sessionId);
    this.pages.delete(targetId);
    if (this.currentId === targetId) this.currentId = undefined;
  }

  private onDetached(sessionId: string): void {
    const page = this.bySession.get(sessionId);
    this.bySession.delete(sessionId);
    if (page) {
      page.sessionId = undefined;
      page.loading = false;
      page.dialog = undefined;
    }
  }

  private async refreshTargets(client: CdpClient): Promise<void> {
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const live = new Set<string>();
    for (const info of targetInfos) {
      if (info.type !== 'page' || info.url.startsWith('devtools://')) continue;
      live.add(info.targetId);
      this.upsertTarget(info);
    }
    for (const id of [...this.targets.keys()]) if (!live.has(id)) this.removeTarget(id);
  }

  /** The current tab, attached and ready. Opens a tab if none exists, relaunches a closed browser. */
  async getPage(): Promise<PageState> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.ensureClient();
        if (!this.currentId || !this.targets.has(this.currentId)) {
          if (this.targets.size === 0) await this.createTarget(client, 'about:blank');
          else this.currentId = [...this.targets.keys()].pop();
        }
        const id = this.currentId!;
        let state = this.pages.get(id);
        if (!state) this.pages.set(id, (state = new PageState(id)));
        await this.attach(client, state);
        return state;
      } catch (err) {
        if (attempt >= 2 || !(err instanceof CdpError) || err instanceof ToolError) throw err;
        // the tab or browser vanished while we were attaching: re-evaluate and retry
        await sleep(200);
      }
    }
  }

  private async createTarget(client: CdpClient, url: string): Promise<string> {
    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url });
    if (!this.targets.has(targetId)) this.targets.set(targetId, { targetId, type: 'page', title: '', url });
    this.currentId = targetId;
    return targetId;
  }

  private async attach(client: CdpClient, state: PageState): Promise<void> {
    if (state.sessionId) return;
    state.attaching ??= (async () => {
      const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId: state.targetId, flatten: true });
      state.sessionId = sessionId;
      state.loading = false;
      state.dialog = undefined;
      this.bySession.set(sessionId, state);
      const cmd = (method: string, params?: object) => client.send(method, params, sessionId, 15_000);
      await Promise.all([
        cmd('Page.enable'),
        cmd('Runtime.enable'),
        cmd('Network.enable', { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 100_000 }),
        cmd('Log.enable'),
      ]);
      try {
        const tree = await cmd('Page.getFrameTree');
        state.mainFrameId = tree.frameTree?.frame?.id;
      } catch {
        // not essential
      }
    })().finally(() => {
      state.attaching = undefined;
    });
    await state.attaching;
  }

  // -------------------------------------------------------------- page events

  private addLog(page: PageState, entry: Omit<ConsoleEntry, 'time'>): void {
    page.logs.push({ time: Date.now(), ...entry });
    if (page.logs.length > LOG_LIMIT) page.logs.shift();
  }

  private onPageEvent(method: string, p: any, sessionId?: string): void {
    const page = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!page) return;
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const frame = p.stackTrace?.callFrames?.[0];
        const levelMap: Record<string, ConsoleEntry['level']> = { warning: 'warn', error: 'error', assert: 'error', info: 'info', debug: 'debug' };
        if (p.type === 'clear') return;
        this.addLog(page, {
          level: levelMap[p.type] ?? 'log',
          text: (p.args ?? []).map(remoteToText).join(' '),
          location: frame?.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}` : undefined,
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        this.addLog(page, {
          level: 'exception',
          text: String(d.exception?.description ?? d.exception?.value ?? d.text ?? 'Uncaught exception').split('\n').slice(0, 4).join('\n'),
          location: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : undefined,
        });
        break;
      }
      case 'Network.requestWillBeSent':
        page.requests.set(p.requestId, { method: p.request?.method ?? 'GET', url: p.request?.url ?? '' });
        if (page.requests.size > 500) page.requests.delete(page.requests.keys().next().value as string);
        break;
      case 'Network.responseReceived': {
        const status = p.response?.status ?? 0;
        const url: string = p.response?.url ?? '';
        if (status >= 400 && !/\/favicon\.ico(\?|$)/.test(url)) {
          const method = page.requests.get(p.requestId)?.method ?? 'GET';
          this.addLog(page, { level: 'network', text: `${status} ${method} ${url}` });
        }
        break;
      }
      case 'Network.loadingFailed': {
        const req = page.requests.get(p.requestId);
        page.requests.delete(p.requestId);
        if (p.canceled || !req || /\/favicon\.ico(\?|$)/.test(req.url)) break;
        this.addLog(page, { level: 'network', text: `FAILED ${req.method} ${req.url}: ${p.blockedReason ?? p.errorText ?? 'error'}` });
        break;
      }
      case 'Network.loadingFinished':
        page.requests.delete(p.requestId);
        break;
      case 'Log.entryAdded': {
        const e = p.entry ?? {};
        if (e.source === 'network') break; // already captured with more detail
        const level: ConsoleEntry['level'] = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : 'info';
        this.addLog(page, { level, text: String(e.text ?? ''), location: e.url ? `${e.url}:${(e.lineNumber ?? 0) + 1}` : undefined });
        break;
      }
      case 'Page.javascriptDialogOpening':
        page.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, url: p.url };
        for (const wake of [...page.dialogWaiters]) wake();
        break;
      case 'Page.javascriptDialogClosed':
        page.dialog = undefined;
        break;
      case 'Page.frameStartedLoading':
        if (p.frameId === page.mainFrameId) page.loading = true;
        break;
      case 'Page.frameStoppedLoading':
        if (p.frameId === page.mainFrameId) page.loading = false;
        break;
      case 'Page.frameNavigated':
        if (!p.frame?.parentId) page.mainFrameId = p.frame?.id;
        break;
      case 'Page.loadEventFired':
        page.loading = false;
        break;
    }
  }

  // ------------------------------------------------------------------ commands

  dialogMessage(page: PageState): string | undefined {
    const d = page.dialog;
    if (!d) return undefined;
    const prompt = d.type === 'prompt' && d.defaultPrompt ? ` (default "${d.defaultPrompt}")` : '';
    return `A JavaScript ${d.type} dialog is open: "${d.message}"${prompt}. ${DIALOG_HINT}`;
  }

  /** Sends a command to a tab. Fails fast with a helpful message while a dialog blocks the page. */
  async cmd<T = any>(page: PageState, method: string, params?: object, timeoutMs = 30_000): Promise<T> {
    const client = await this.ensureClient();
    if (!page.sessionId) throw new ToolError('The tab was closed or detached. Call the tool again.');
    try {
      return await client.send<T>(method, params, page.sessionId, timeoutMs);
    } catch (err) {
      if (err instanceof CdpError && /timed out/.test(err.message) && page.dialog) throw new ToolError(this.dialogMessage(page)!);
      if (err instanceof CdpError && /closed/i.test(err.message)) {
        throw new ToolError('The browser was closed. Call the tool again to reopen it.');
      }
      if (err instanceof CdpError && /(session with given id|no session|target closed|no target with given id)/i.test(err.message)) {
        throw new ToolError('The tab was closed. Call browser_tabs to see what is open.');
      }
      throw err;
    }
  }

  /**
   * Runs a command that may trigger a JavaScript dialog (clicks, key presses, eval, navigation).
   * Those commands stay pending until the dialog is handled, so resolve early when one opens.
   */
  async raceDialog<T>(page: PageState, promise: Promise<T>): Promise<{ value?: T; dialog: boolean }> {
    promise.catch(() => undefined);
    if (page.dialog) return { dialog: true };
    let wake!: () => void;
    const opened = new Promise<'dialog'>((resolve) => {
      wake = () => resolve('dialog');
      page.dialogWaiters.add(wake);
    });
    try {
      const result = await Promise.race([promise.then((value) => ({ value, dialog: false })), opened.then(() => ({ dialog: true }))]);
      return result as { value?: T; dialog: boolean };
    } finally {
      page.dialogWaiters.delete(wake);
    }
  }

  /** Evaluates JavaScript in the page and returns the JSON value. Throws ToolError on exceptions. */
  async evaluate<T = any>(page: PageState, expression: string, opts: { awaitPromise?: boolean; timeoutMs?: number; allowDialog?: boolean } = {}): Promise<T> {
    const run = async (expr: string, byValue: boolean): Promise<any> =>
      this.cmd(
        page,
        'Runtime.evaluate',
        { expression: expr, returnByValue: byValue, awaitPromise: opts.awaitPromise ?? true, userGesture: true },
        opts.timeoutMs ?? 30_000,
      );

    for (let attempt = 0; ; attempt++) {
      const blocked = this.dialogMessage(page);
      if (blocked) throw new ToolError(blocked);
      let res: any;
      try {
        if (opts.allowDialog) {
          const raced = await this.raceDialog(page, run(expression, true));
          if (raced.dialog) throw new ToolError(this.dialogMessage(page) ?? `A JavaScript dialog opened. ${DIALOG_HINT}`);
          res = raced.value;
        } else {
          res = await run(expression, true);
        }
      } catch (err) {
        if (attempt === 0 && err instanceof CdpError && /(context|navigat)/i.test(err.message)) {
          await sleep(300);
          await this.waitForLoad(page, 10_000);
          continue;
        }
        throw err;
      }
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        const text = String(d.exception?.description ?? d.exception?.value ?? d.text ?? 'Script error');
        if (/Execution context was destroyed|Cannot find context/.test(text) && attempt === 0) {
          await sleep(300);
          await this.waitForLoad(page, 10_000);
          continue;
        }
        throw new ToolError(text.split('\n').slice(0, 6).join('\n'));
      }
      const r = res.result ?? {};
      if (r.type === 'undefined') return undefined as T;
      if ('value' in r) return r.value as T;
      return (r.description ?? r.type) as T;
    }
  }

  // ---------------------------------------------------------------- navigation

  async navigate(page: PageState, url: string, signal?: AbortSignal): Promise<{ timedOut: boolean; dialog: boolean }> {
    const raced = await this.raceDialog(page, this.cmd(page, 'Page.navigate', { url }, 30_000));
    if (raced.dialog) return { timedOut: false, dialog: true };
    const res = raced.value as { errorText?: string; loaderId?: string };
    if (res.errorText) throw new ToolError(`Navigation to ${url} failed: ${res.errorText}`);
    if (!res.loaderId) return { timedOut: false, dialog: false }; // same-document navigation
    const { timedOut } = await this.waitForLoad(page, LOAD_TIMEOUT, signal);
    return { timedOut, dialog: !!page.dialog };
  }

  /** Waits until the document finished loading (or a dialog opens, or the timeout passes). */
  async waitForLoad(page: PageState, timeoutMs = LOAD_TIMEOUT, signal?: AbortSignal): Promise<{ timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throwIfAborted(signal);
      if (page.dialog) return { timedOut: false };
      if (!page.loading) {
        try {
          const state = await this.cmd(page, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 5000);
          if (state.result?.value === 'complete') return { timedOut: false };
        } catch {
          // context swapping during navigation: retry
        }
      }
      await sleep(100, signal);
    }
    return { timedOut: true };
  }

  /** After an action: wait for a started navigation to finish, then for the DOM to stop changing. */
  async settle(page: PageState, signal?: AbortSignal, opts: { quietMs?: number; capMs?: number } = {}): Promise<void> {
    await sleep(120, signal);
    if (page.dialog) return;
    if (page.loading) await this.waitForLoad(page, 15_000, signal);
    if (page.dialog) return;
    const quiet = opts.quietMs ?? 300;
    const cap = opts.capMs ?? 3000;
    const script = `new Promise((resolve) => {
      let t; const done = () => { try { obs.disconnect(); } catch (e) {} clearTimeout(t); clearTimeout(c); resolve(true); };
      const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ${quiet}); });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      t = setTimeout(done, ${quiet}); const c = setTimeout(done, ${cap});
    })`;
    try {
      await abortable(this.evaluate(page, script, { timeoutMs: cap + 5000 }), signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (page.dialog) return;
      // the page navigated under us
      await this.waitForLoad(page, 15_000, signal);
    }
  }

  async pageInfo(page: PageState): Promise<{ title: string; url: string }> {
    if (!page.dialog) {
      try {
        const info = await this.evaluate<{ title: string; url: string }>(page, '({ title: document.title, url: location.href })', { timeoutMs: 5000 });
        if (info && typeof info.url === 'string') return info;
      } catch {
        // fall through to the cached target info
      }
    }
    const t = this.targets.get(page.targetId);
    return { title: t?.title ?? '', url: t?.url ?? '' };
  }

  // ------------------------------------------------------------------- console

  getLogs(page: PageState): ConsoleEntry[] {
    return [...page.logs];
  }

  clearLogs(page: PageState): void {
    page.logs.length = 0;
  }

  // ---------------------------------------------------------------------- tabs

  async listTabs(): Promise<TabInfo[]> {
    await this.getPage();
    const client = await this.ensureClient();
    await this.refreshTargets(client);
    return [...this.targets.values()].map((t, i) => ({
      index: i + 1,
      targetId: t.targetId,
      title: t.title,
      url: t.url,
      current: t.targetId === this.currentId,
    }));
  }

  private async resolveTab(spec: number | string | undefined): Promise<TabInfo> {
    const tabs = await this.listTabs();
    if (spec === undefined || spec === '') return tabs.find((t) => t.current) ?? tabs[0];
    const asNumber = typeof spec === 'number' ? spec : /^\d+$/.test(spec.trim()) ? Number(spec) : NaN;
    if (!Number.isNaN(asNumber)) {
      const tab = tabs[asNumber - 1];
      if (!tab) throw new ToolError(`There is no tab ${asNumber}. Open tabs: ${tabs.length} (numbered 1-${tabs.length}).`);
      return tab;
    }
    const needle = String(spec).toLowerCase();
    const tab = tabs.find((t) => t.url.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle));
    if (!tab) throw new ToolError(`No tab matches "${spec}".`);
    return tab;
  }

  async newTab(): Promise<void> {
    const client = await this.ensureClient();
    const targetId = await this.createTarget(client, 'about:blank');
    await client.send('Target.activateTarget', { targetId }).catch(() => undefined);
    await this.getPage();
  }

  async switchTab(spec: number | string): Promise<TabInfo> {
    const tab = await this.resolveTab(spec);
    const client = await this.ensureClient();
    this.currentId = tab.targetId;
    await client.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => undefined);
    await this.getPage();
    return tab;
  }

  async closeTab(spec?: number | string): Promise<TabInfo> {
    const tab = await this.resolveTab(spec);
    const client = await this.ensureClient();
    await client.send('Target.closeTarget', { targetId: tab.targetId });
    for (let i = 0; i < 30 && this.targets.has(tab.targetId); i++) {
      await sleep(100);
      if (i % 5 === 4) await this.refreshTargets(client).catch(() => undefined);
    }
    this.removeTarget(tab.targetId);
    return tab;
  }

  // ------------------------------------------------------------------- cleanup

  /** Closes our connections, and the browser itself only if this session launched it. */
  async dispose(): Promise<void> {
    const client = this.client;
    const child = this.child;
    this.client = undefined;
    this.child = undefined;
    this.resetState();
    if (child && child.exitCode === null) {
      if (client && !client.closed) await client.send('Browser.close', undefined, undefined, 2000).catch(() => undefined);
      await waitExit(child, 3000);
      if (child.exitCode === null) await killTree(child);
      await waitExit(child, 2000);
    }
    client?.close();
    if (this.connecting) await this.connecting.then((c) => c.close(), () => undefined);
  }
}

function remoteToText(arg: any): string {
  if (arg === null || arg === undefined) return String(arg);
  if (arg.type === 'string') return String(arg.value);
  if ('value' in arg) return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
  if (arg.unserializableValue) return String(arg.unserializableValue);
  return String(arg.description ?? arg.type);
}
