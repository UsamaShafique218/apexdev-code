import * as path from 'path';
import type { BackgroundProcesses, ShellInfo } from './shell';

/**
 * read: never needs approval (and may run in parallel with other reads) · edit: changes files ·
 * execute: runs programs · interact: acts on the browser or desktop (clicks, typing, launching apps)
 */
export type ToolKind = 'read' | 'edit' | 'execute' | 'interact';

export interface ToolImage {
  mime: 'image/png' | 'image/jpeg';
  /** base64, without the data: prefix */
  data: string;
}

/** Tools return plain text, or text plus images (screenshots) the model should see. */
export interface ToolResult {
  text: string;
  images?: ToolImage[];
}

export interface ToolContext {
  /** Workspace root; relative paths resolve against it. */
  cwd: string;
  signal: AbortSignal;
  shell: ShellInfo;
  background: BackgroundProcesses;
  /** Files the model has read in this chat — edits require a prior read. */
  readFiles: Set<string>;
  /** VS Code integration; absent in tests and sub-agents without an editor. */
  ide?: IdeBridge;
  /** Live status line for long-running tools (shown on the tool card). */
  progress?: (message: string) => void;
}

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

export interface EditorState {
  workspaceFolders: string[];
  activeFile?: string;
  cursor?: { line: number; column: number };
  selection?: { startLine: number; endLine: number; text: string };
  openEditors: string[];
  unsavedFiles: string[];
  terminals: string[];
  debugSessions: string[];
  problems: { errors: number; warnings: number };
}

/** The slice of the VS Code API the tools use. Implemented in src/ide/vscodeBridge.ts. */
export interface IdeBridge {
  diagnostics(absPath?: string, waitMs?: number): Promise<Diagnostic[]>;
  editorState(): EditorState;
  openFile(absPath: string, line?: number, column?: number): Promise<void>;
  listTasks(): Promise<Array<{ name: string; source: string; group?: string }>>;
  runTask(name: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode?: number; timedOut: boolean }>;
  startDebugging(configName?: string): Promise<string>;
  stopDebugging(): Promise<string>;
  executeCommand(command: string, args: unknown[]): Promise<unknown>;
}

export interface Tool<I = any> {
  name: string;
  /** Short verb shown in the UI, e.g. "Read", "Run". */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: ToolKind;
  /** One-line human summary of a call, shown in the UI and permission prompts. */
  summarize(input: I): string;
  execute(input: I, ctx: ToolContext): Promise<string | ToolResult>;
}

/** An expected failure whose message is returned to the model as-is. */
export class ToolError extends Error {}

export const MAX_TOOL_OUTPUT = 30_000;

export function resolvePath(cwd: string, p: string | undefined): string {
  if (!p || p === '.') return cwd;
  let value = p.trim();
  // Git Bash style /d/folder → D:\folder
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(value);
    if (msys) value = `${msys[1].toUpperCase()}:${msys[2] ?? '/'}`;
  }
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

/** Key used for the read-before-edit check (case-insensitive on Windows). */
export function fileKey(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
}

export function displayPath(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : absPath;
  return shown.split(path.sep).join('/');
}

/** Keeps the head and tail of long output so errors at the end stay visible. */
export function truncateMiddle(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - max;
  return `${text.slice(0, half)}\n\n… [${omitted} characters omitted] …\n\n${text.slice(-half)}`;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('Cancelled by the user.');
}
