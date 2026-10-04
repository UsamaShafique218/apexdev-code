import { Diagnostic, Tool, ToolContext, ToolError, displayPath, resolvePath } from './types';

function requireIde(ctx: ToolContext) {
  if (!ctx.ide) throw new ToolError('VS Code integration is not available in this context.');
  return ctx.ide;
}

export function formatDiagnostics(cwd: string, items: Diagnostic[], limit = 100): string {
  if (!items.length) return 'No problems.';
  const order = { error: 0, warning: 1, info: 2, hint: 3 };
  const sorted = items.slice().sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  const lines = sorted
    .slice(0, limit)
    .map((d) => `${displayPath(cwd, d.path)}:${d.line}:${d.column} ${d.severity}${d.source ? ` [${d.source}${d.code ? ` ${d.code}` : ''}]` : ''}: ${d.message}`);
  const errors = items.filter((d) => d.severity === 'error').length;
  const warnings = items.filter((d) => d.severity === 'warning').length;
  const more = items.length > limit ? `\n… ${items.length - limit} more` : '';
  return `${errors} error(s), ${warnings} warning(s)\n${lines.join('\n')}${more}`;
}

export const diagnosticsTool: Tool<{ path?: string; include_warnings?: boolean }> = {
  name: 'ide_diagnostics',
  label: 'Problems',
  kind: 'read',
  description:
    'Get the problems (errors and warnings) reported by VS Code language servers, linters and type checkers — the Problems panel. ' +
    'Pass a path to check one file (it is opened in the background so its language server analyses it). ' +
    'Use this after editing code to catch type and syntax errors without running a full build.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to check. Omit for the whole workspace.' },
      include_warnings: { type: 'boolean', description: 'Include warnings and hints (default true).' },
    },
  },
  summarize: (i) => i.path ?? 'workspace',
  async execute(input, ctx) {
    const ide = requireIde(ctx);
    const abs = input.path ? resolvePath(ctx.cwd, input.path) : undefined;
    let items = await ide.diagnostics(abs, abs ? 2000 : 0);
    if (input.include_warnings === false) items = items.filter((d) => d.severity === 'error');
    return formatDiagnostics(ctx.cwd, items);
  },
};

export const editorStateTool: Tool<Record<string, never>> = {
  name: 'ide_state',
  label: 'Editor',
  kind: 'read',
  description:
    'Current VS Code state: workspace folders, the active file with cursor and selected text, open editors, unsaved files, ' +
    'terminals, running debug sessions and problem counts. Use it when the user refers to "this file", "the selection" or "what I have open".',
  parameters: { type: 'object', properties: {} },
  summarize: () => 'active file, selection, open editors',
  async execute(_input, ctx) {
    const s = requireIde(ctx).editorState();
    const rel = (p: string) => displayPath(ctx.cwd, p);
    const lines = [
      `Workspace folders: ${s.workspaceFolders.join(', ') || 'none'}`,
      `Active file: ${s.activeFile ? rel(s.activeFile) : 'none'}${s.cursor ? ` (line ${s.cursor.line}, column ${s.cursor.column})` : ''}`,
    ];
    if (s.selection) {
      lines.push(`Selection: lines ${s.selection.startLine}-${s.selection.endLine}\n\`\`\`\n${s.selection.text}\n\`\`\``);
    }
    lines.push(
      `Open editors: ${s.openEditors.map(rel).join(', ') || 'none'}`,
      `Unsaved files: ${s.unsavedFiles.map(rel).join(', ') || 'none'}`,
      `Terminals: ${s.terminals.join(', ') || 'none'}`,
      `Debug sessions: ${s.debugSessions.join(', ') || 'none'}`,
      `Problems: ${s.problems.errors} error(s), ${s.problems.warnings} warning(s)`,
    );
    return lines.join('\n');
  },
};

export const openFileTool: Tool<{ path: string; line?: number; column?: number }> = {
  name: 'open_file',
  label: 'Open',
  kind: 'read',
  description: 'Open a file in the VS Code editor (optionally at a line) so the user sees what you are talking about or working on.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root or absolute.' },
      line: { type: 'integer', description: '1-based line to reveal.' },
      column: { type: 'integer', description: '1-based column.' },
    },
    required: ['path'],
  },
  summarize: (i) => (i.line ? `${i.path}:${i.line}` : i.path),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    try {
      await requireIde(ctx).openFile(abs, input.line, input.column);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Could not open ${displayPath(ctx.cwd, abs)}: ${(err as Error).message}`);
    }
    return `Opened ${displayPath(ctx.cwd, abs)}${input.line ? ` at line ${input.line}` : ''}.`;
  },
};

export const listTasksTool: Tool<Record<string, never>> = {
  name: 'ide_tasks',
  label: 'Tasks',
  kind: 'read',
  description: 'List the VS Code tasks defined for this workspace (tasks.json, npm scripts, detected build tasks).',
  parameters: { type: 'object', properties: {} },
  summarize: () => 'list tasks',
  async execute(_input, ctx) {
    const tasks = await requireIde(ctx).listTasks();
    if (!tasks.length) return 'No tasks found.';
    return tasks.map((t) => `${t.name} (${t.source}${t.group ? `, ${t.group}` : ''})`).join('\n');
  },
};

export const runTaskTool: Tool<{ name: string; timeout_ms?: number }> = {
  name: 'run_task',
  label: 'Task',
  kind: 'execute',
  description:
    'Run a VS Code task by name (see ide_tasks) in the integrated terminal and wait for it to finish. ' +
    'Returns the exit code; task output is shown to the user in the terminal, not returned. ' +
    'Prefer run_command when you need to read the output.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Task name, e.g. "build" or "npm: test".' },
      timeout_ms: { type: 'integer', description: 'How long to wait (default 300000).' },
    },
    required: ['name'],
  },
  summarize: (i) => i.name,
  async execute(input, ctx) {
    const result = await requireIde(ctx).runTask(input.name, Math.min(input.timeout_ms ?? 300_000, 1_800_000), ctx.signal);
    if (result.timedOut) return `Task "${input.name}" is still running (stopped waiting). Check the terminal or run_command for output.`;
    return `Task "${input.name}" finished with exit code ${result.exitCode ?? 'unknown'}.`;
  },
};

export const debugTool: Tool<{ action: 'start' | 'stop'; config?: string }> = {
  name: 'debug',
  label: 'Debug',
  kind: 'execute',
  description: 'Start a VS Code debug session (by launch configuration name, or the first one in launch.json) or stop the active session.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop'] },
      config: { type: 'string', description: 'Launch configuration name.' },
    },
    required: ['action'],
  },
  summarize: (i) => (i.action === 'stop' ? 'stop' : `start ${i.config ?? ''}`.trim()),
  async execute(input, ctx) {
    const ide = requireIde(ctx);
    return input.action === 'stop' ? ide.stopDebugging() : ide.startDebugging(input.config);
  },
};

export const vscodeCommandTool: Tool<{ command: string; args?: unknown[] }> = {
  name: 'vscode_command',
  label: 'Command',
  kind: 'execute',
  description:
    'Execute a VS Code command by id with optional JSON arguments, e.g. "editor.action.formatDocument", ' +
    '"workbench.action.files.saveAll", "workbench.action.reloadWindow". Returns the command result if it is serialisable.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: {}, description: 'Arguments passed to the command.' },
    },
    required: ['command'],
  },
  summarize: (i) => i.command,
  async execute(input, ctx) {
    const result = await requireIde(ctx).executeCommand(input.command, input.args ?? []);
    if (result === undefined) return `Executed ${input.command}.`;
    try {
      return `Executed ${input.command}. Result:\n${JSON.stringify(result, null, 2)}`;
    } catch {
      return `Executed ${input.command}. Result: ${String(result)}`;
    }
  },
};

export const ideTools: Tool[] = [
  diagnosticsTool,
  editorStateTool,
  openFileTool,
  listTasksTool,
  runTaskTool,
  debugTool,
  vscodeCommandTool,
];
