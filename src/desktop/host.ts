import { ChildProcess, spawn } from 'child_process';
import { mkdirSync, promises as fs } from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

export class DesktopError extends Error {}

export interface DesktopHostOptions {
  /** Path to resources/desktop/host.ps1 */
  scriptPath: string;
  /** Folder for temporary screenshot files. */
  tempDir: string;
  /** Longest side of screenshots sent to the model, in pixels (default 1366). */
  maxImageSize?: number;
}

export type MonitorSpec = 'active' | 'primary' | 'all' | number;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Geometry of the latest screenshot: it defines the coordinate space of every coordinate-taking tool. */
export interface Geometry {
  /** Physical screen position of the image's top-left corner. */
  monitorLeft: number;
  monitorTop: number;
  /** image px / physical px */
  scale: number;
  imageWidth: number;
  imageHeight: number;
  /** Physical size of the captured area. */
  physWidth: number;
  physHeight: number;
  /** Monitor index (-1 = all monitors). */
  monitor: number;
}

export interface WindowInfo {
  hwnd: number;
  title: string;
  process: string;
  pid: number;
  /** physical pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
  maximized: boolean;
  active?: boolean;
}

export interface MonitorInfo {
  index: number;
  primary: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenshotReply {
  path: string;
  monitor: number;
  x: number;
  y: number;
  w: number;
  h: number;
  imageWidth: number;
  imageHeight: number;
  scale: number;
  monitors: MonitorInfo[];
  active: WindowInfo | null;
  cursor: { x: number; y: number };
}

export interface ScreenshotResult {
  image: Buffer;
  reply: ScreenshotReply;
  geometry: Geometry;
}

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine extends OcrWord {
  words: OcrWord[];
}

export function geometryFromReply(r: ScreenshotReply): Geometry {
  return {
    monitorLeft: r.x,
    monitorTop: r.y,
    scale: r.scale,
    imageWidth: r.imageWidth,
    imageHeight: r.imageHeight,
    physWidth: r.w,
    physHeight: r.h,
    monitor: r.monitor,
  };
}

/** Screenshot pixel -> physical screen pixel. */
export function imageToPhysical(g: Geometry, x: number, y: number): { x: number; y: number } {
  return { x: Math.round(g.monitorLeft + x / g.scale), y: Math.round(g.monitorTop + y / g.scale) };
}

/** Physical screen pixel -> screenshot pixel. */
export function physicalToImage(g: Geometry, x: number, y: number): { x: number; y: number } {
  return { x: Math.round((x - g.monitorLeft) * g.scale), y: Math.round((y - g.monitorTop) * g.scale) };
}

export function physicalRectToImage(g: Geometry, r: Rect): Rect {
  const p = physicalToImage(g, r.x, r.y);
  return { x: p.x, y: p.y, w: Math.round(r.w * g.scale), h: Math.round(r.h * g.scale) };
}

export function imageRectToPhysical(g: Geometry, r: Rect): Rect {
  const p = imageToPhysical(g, r.x, r.y);
  return { x: p.x, y: p.y, w: Math.round(r.w / g.scale), h: Math.round(r.h / g.scale) };
}

export function centerOf(r: Rect): { x: number; y: number } {
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
}

interface Session {
  proc: ChildProcess;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
  stderr: string;
  exited: boolean;
}

const START_TIMEOUT = 45_000;

/** Owns the PowerShell desktop helper: lazy start, one request at a time, restart on hang or crash. */
export class DesktopHost {
  private session: Session | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private shotCounter = 0;
  private disposed = false;
  private geometry: Geometry | undefined;
  private readonly maxImageSize: number;

  constructor(private readonly opts: DesktopHostOptions) {
    this.maxImageSize = opts.maxImageSize ?? 1366;
  }

  /** Geometry of the latest screenshot, if one has been taken. */
  getGeometry(): Geometry | undefined {
    return this.geometry;
  }

  setGeometry(g: Geometry | undefined): void {
    this.geometry = g;
  }

  /** Sends a command to the helper. Requests are serialised; the promise rejects on timeout, abort or helper death. */
  request<T = any>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new DesktopError('The desktop helper has been shut down.'));
    if (signal?.aborted) return Promise.reject(new DesktopError('Cancelled by the user.'));
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(new DesktopError('Cancelled by the user.')));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.chain = this.chain.then(async () => {
        if (done) return;
        try {
          const result = await this.exchange(cmd, args, timeoutMs);
          finish(() => resolve(result as T));
        } catch (err) {
          finish(() => reject(err));
        }
      });
    });
  }

  /** Takes a screenshot and makes it the coordinate space for later calls. */
  async screenshot(opts: { monitor?: MonitorSpec; region?: Rect } = {}, signal?: AbortSignal): Promise<ScreenshotResult> {
    mkdirSync(this.opts.tempDir, { recursive: true });
    const file = path.join(this.opts.tempDir, `shot-${process.pid}-${Date.now()}-${this.shotCounter++}.jpg`);
    let region: Rect | undefined;
    if (opts.region) {
      const g = this.geometry ?? (await this.ensureGeometry(signal));
      region = imageRectToPhysical(g, opts.region);
    }
    const reply = await this.request<ScreenshotReply>(
      'screenshot',
      { path: file, monitor: opts.monitor ?? 'active', region, maxSize: this.maxImageSize },
      30_000,
      signal,
    );
    let image: Buffer;
    try {
      image = await fs.readFile(reply.path);
    } catch {
      throw new DesktopError('The screenshot file could not be read.');
    } finally {
      fs.unlink(reply.path).catch(() => undefined);
    }
    const geometry = geometryFromReply(reply);
    this.geometry = geometry;
    return { image, reply, geometry };
  }

  /** Returns the current geometry, taking a screenshot first if none exists yet. */
  async ensureGeometry(signal?: AbortSignal): Promise<Geometry> {
    if (this.geometry) return this.geometry;
    return (await this.screenshot({}, signal)).geometry;
  }

  /** OCR of the area covered by the latest screenshot. Results are in screenshot coordinates. */
  async ocr(signal?: AbortSignal): Promise<{ language: string; lines: OcrLine[] }> {
    const g = await this.ensureGeometry(signal);
    mkdirSync(this.opts.tempDir, { recursive: true });
    const file = path.join(this.opts.tempDir, `ocr-${process.pid}-${Date.now()}-${this.shotCounter++}.png`);
    const res = await this.request<{ language: string; lines: OcrLine[] }>(
      'ocr',
      { path: file, x: g.monitorLeft, y: g.monitorTop, w: g.physWidth, h: g.physHeight },
      60_000,
      signal,
    );
    const conv = <T extends Rect>(o: T): T => ({ ...o, ...physicalRectToImage(g, o) });
    return {
      language: res.language,
      lines: (res.lines ?? []).map((line) => ({ ...conv(line), words: (line.words ?? []).map((w) => conv(w)) })),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.killSession();
  }

  // ---- internals ----

  private async exchange(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const session = await this.ensureStarted();
    return this.send(session, cmd, args, timeoutMs);
  }

  private async ensureStarted(): Promise<Session> {
    if (this.session && !this.session.exited) return this.session;
    if (process.platform !== 'win32') throw new DesktopError('Desktop control is only available on Windows.');
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.opts.scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const session: Session = { proc, pending: new Map(), buffer: '', stderr: '', exited: false };
    const decoder = new StringDecoder('utf8');
    proc.stdout!.on('data', (chunk: Buffer) => {
      session.buffer += decoder.write(chunk);
      let nl: number;
      while ((nl = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, nl).trim();
        session.buffer = session.buffer.slice(nl + 1);
        if (line) this.onLine(session, line);
      }
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      session.stderr = (session.stderr + chunk.toString('utf8')).slice(-2000);
    });
    proc.stdin!.on('error', () => undefined);
    const onDeath = (reason: string) => {
      if (session.exited) return;
      session.exited = true;
      if (this.session === session) this.session = undefined;
      const detail = session.stderr.trim() ? ` ${session.stderr.trim().slice(0, 500)}` : '';
      for (const p of session.pending.values()) p.reject(new DesktopError(`The desktop helper stopped (${reason}).${detail}`));
      session.pending.clear();
    };
    proc.on('error', (err) => onDeath(err.message));
    proc.on('exit', (code) => onDeath(`exit code ${code}`));
    this.session = session;
    try {
      await this.send(session, 'ping', {}, START_TIMEOUT);
    } catch (err) {
      this.killSession();
      throw err;
    }
    return session;
  }

  private onLine(session: Session, line: string): void {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const pending = session.pending.get(msg.id);
    if (!pending) return;
    session.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new DesktopError(msg.error || 'Unknown desktop helper error.'));
  }

  private send(session: Session, cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        if (this.session === session) this.killSession();
        reject(new DesktopError(`The desktop command "${cmd}" did not finish within ${Math.round(timeoutMs / 1000)}s; the helper was restarted.`));
      }, timeoutMs);
      session.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        session.proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
      } catch (err) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(new DesktopError(`Could not talk to the desktop helper: ${(err as Error).message}`));
      }
    });
  }

  private killSession(): void {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    const pid = session.proc.pid;
    try {
      session.proc.stdin?.end();
    } catch {
      // ignore
    }
    if (pid !== undefined && !session.exited) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      } catch {
        // already gone
      }
    }
    // Make sure nothing waits forever on a session we no longer track.
    setTimeout(() => {
      for (const p of session.pending.values()) p.reject(new DesktopError('The desktop helper was shut down.'));
      session.pending.clear();
    }, 2000).unref();
  }
}
