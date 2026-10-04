import WebSocket from 'ws';

/** A protocol-level failure (error response, timeout or closed connection). */
export class CdpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

export type CdpListener = (params: any, sessionId?: string) => void;

interface Pending {
  method: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT = 30_000;

/** Minimal Chrome DevTools Protocol client over a single websocket (browser or page endpoint). */
export class CdpClient {
  closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private readonly closeListeners = new Set<() => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => this.handleClose());
    ws.on('error', () => this.handleClose());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024, handshakeTimeout: timeoutMs });
      const fail = (err: Error) => {
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new CdpError(`Could not connect to the browser: ${err.message}`));
      };
      ws.once('error', fail);
      ws.once('unexpected-response', (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
      ws.once('open', () => {
        ws.removeListener('error', fail);
        resolve(new CdpClient(ws));
      });
    });
  }

  send<T = any>(method: string, params?: object, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('Browser connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      const message: Record<string, unknown> = { id, method };
      if (params) message.params = params;
      if (sessionId) message.sessionId = sessionId;
      this.ws.send(JSON.stringify(message), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${method} failed: ${err.message}`));
      });
    });
  }

  /** Subscribes to a protocol event; returns an unsubscribe function. */
  on(method: string, cb: CdpListener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(cb);
    return () => this.off(method, cb);
  }

  off(method: string, cb: CdpListener): void {
    this.listeners.get(method)?.delete(cb);
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeListeners.add(cb);
  }

  close(): void {
    if (!this.closed) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }
    this.handleClose();
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new CdpError(`${pending.method}: ${msg.error.message ?? 'error'}`, msg.error.code));
      else pending.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const cb of [...set]) {
        try {
          cb(msg.params ?? {}, msg.sessionId);
        } catch {
          // a faulty listener must not break the connection
        }
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError('Browser connection closed.'));
    }
    this.pending.clear();
    for (const cb of [...this.closeListeners]) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
    this.closeListeners.clear();
  }
}
