import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolError, truncateMiddle } from './types';

export type ShellPreference = 'auto' | 'bash' | 'powershell' | 'cmd';

export interface ShellInfo {
  name: 'bash' | 'powershell' | 'cmd' | 'sh';
  path: string;
  args(command: string): string[];
  verbatim?: boolean;
}

function findGitBash(): string | undefined {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432];
  const candidates = roots.filter(Boolean).map((root) => path.join(root!, 'Git', 'bin', 'bash.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  return candidates.find((c) => existsSync(c));
}

export function detectShell(preference: ShellPreference = 'auto'): ShellInfo {
  const bash = (p: string): ShellInfo => ({ name: 'bash', path: p, args: (c) => ['-c', c] });
  const powershell: ShellInfo = {
    name: 'powershell',
    path: 'powershell.exe',
    args: (c) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c],
  };
  const cmd: ShellInfo = {
    name: 'cmd',
    path: process.env.ComSpec || 'cmd.exe',
    args: (c) => ['/d', '/s', '/c', `"${c}"`],
    verbatim: true,
  };

  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    return { name: sh.endsWith('bash') ? 'bash' : 'sh', path: sh, args: (c) => ['-c', c] };
  }
  if (preference === 'powershell') return powershell;
  if (preference === 'cmd') return cmd;
  const gitBash = findGitBash();
  if (gitBash) return bash(gitBash);
  return preference === 'bash' ? bash('bash.exe') : powershell;
}

const MAX_BUFFER = 1_000_000;

class ProcessRecord {
  output = '';
  unread = '';
  exitCode: number | null = null;
  exited = false;
  readonly exitPromise: Promise<void>;

  constructor(readonly id: number, readonly command: string, readonly child: ChildProcess) {
    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.output = (this.output + text).slice(-MAX_BUFFER);
      this.unread = (this.unread + text).slice(-MAX_BUFFER);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    this.exitPromise = new Promise((resolve) => {
      child.on('error', (err) => {
        append(Buffer.from(`\n${err.message}\n`));
        this.exited = true;
        resolve();
      });
      child.on('close', (code) => {
        this.exitCode = code;
        this.exited = true;
        resolve();
      });
    });
  }

  takeUnread(): string {
    const text = this.unread;
    this.unread = '';
    return text;
  }

  kill(): void {
    if (this.exited || this.child.pid === undefined) return;
    killTree(this.child.pid);
  }
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

/** Long-running processes (dev servers, watchers) started with run_command background=true. */
export class BackgroundProcesses {
  private nextId = 1;
  private readonly records = new Map<number, ProcessRecord>();

  start(command: string, ctx: Pick<ToolContext, 'cwd' | 'shell'>): ProcessRecord {
    const record = new ProcessRecord(this.nextId++, command, spawnShell(command, ctx));
    this.records.set(record.id, record);
    return record;
  }

  get(id: number): ProcessRecord | undefined {
    return this.records.get(id);
  }

  list(): ProcessRecord[] {
    return [...this.records.values()];
  }

  killAll(): void {
    for (const record of this.records.values()) record.kill();
    this.records.clear();
  }
}

function spawnShell(command: string, ctx: Pick<ToolContext, 'cwd' | 'shell'>): ChildProcess {
  return spawn(ctx.shell.path, ctx.shell.args(command), {
    cwd: ctx.cwd,
    env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
    windowsVerbatimArguments: ctx.shell.verbatim,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

export const runCommandTool: Tool<{ command: string; timeout_ms?: number; background?: boolean }> = {
  name: 'run_command',
  label: 'Run',
  kind: 'execute',
  description:
    'Run a shell command in the workspace root and return its combined stdout/stderr and exit code. ' +
    'Commands must be non-interactive (no prompts, no editors; pass flags like --yes). ' +
    `Default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s. ` +
    'For servers and watchers set background=true, then read their output later with command_output.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      timeout_ms: { type: 'integer', description: `Timeout in milliseconds (max ${MAX_TIMEOUT}).` },
      background: { type: 'boolean', description: 'Keep running in the background and return after a few seconds.' },
    },
    required: ['command'],
  },
  summarize: (i) => i.command,
  async execute(input, ctx) {
    if (!input.command?.trim()) throw new ToolError('command is empty.');

    if (input.background) {
      const record = ctx.background.start(input.command, ctx);
      await Promise.race([record.exitPromise, delay(3000)]);
      const initial = truncateMiddle(record.takeUnread().trim() || '(no output yet)', 10_000);
      if (record.exited) return `${initial}\n[process exited immediately with code ${record.exitCode}]`;
      return `Started background process #${record.id} (pid ${record.child.pid}).\nInitial output:\n${initial}\n` +
        `Use command_output with id=${record.id} to read more output or stop it.`;
    }

    const timeout = Math.min(Math.max(input.timeout_ms ?? DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
    const record = new ProcessRecord(0, input.command, spawnShell(input.command, ctx));
    let outcome: 'exit' | 'timeout' | 'abort' = 'exit';
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => record.kill();
    ctx.signal.addEventListener('abort', onAbort);
    try {
      outcome = await Promise.race([
        record.exitPromise.then(() => 'exit' as const),
        new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeout))),
        new Promise<'abort'>((resolve) => {
          if (ctx.signal.aborted) resolve('abort');
          ctx.signal.addEventListener('abort', () => resolve('abort'));
        }),
      ]);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
    if (outcome !== 'exit') record.kill();

    const output = truncateMiddle(record.output.trimEnd()) || '(no output)';
    if (outcome === 'timeout') return `${output}\n[timed out after ${timeout / 1000}s — process killed]`;
    if (outcome === 'abort') throw new ToolError(`${output}\n[cancelled by the user]`);
    return `${output}\n[exit code: ${record.exitCode ?? 'unknown'}]`;
  },
};

export const commandOutputTool: Tool<{ id: number; kill?: boolean }> = {
  name: 'command_output',
  label: 'Output',
  kind: 'read',
  description: 'Read new output from a background process started by run_command, or stop it with kill=true.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'Background process id returned by run_command.' },
      kill: { type: 'boolean', description: 'Stop the process.' },
    },
    required: ['id'],
  },
  summarize: (i) => `#${i.id}${i.kill ? ' (stop)' : ''}`,
  async execute(input, ctx) {
    const record = ctx.background.get(input.id);
    if (!record) {
      const ids = ctx.background.list().map((r) => `#${r.id} ${r.command}`);
      throw new ToolError(`No background process #${input.id}. Running: ${ids.join(', ') || 'none'}.`);
    }
    if (input.kill) {
      record.kill();
      await Promise.race([record.exitPromise, delay(3000)]);
    }
    const output = truncateMiddle(record.takeUnread().trimEnd()) || '(no new output)';
    const status = record.exited ? `exited with code ${record.exitCode}` : 'still running';
    return `${output}\n[process #${record.id} ${status}]`;
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+(\/[a-z]\s+)*\/[sq]\b/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bformat\s+[a-z]:/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bshutdown\b|\brestart-computer\b/i,
  /\bmkfs\b|\bdd\s+if=/,
  /\breg\s+(delete|add)\b/i,
];

/** Commands that always require explicit approval, whatever the permission mode. */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}
