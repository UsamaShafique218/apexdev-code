import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildSystemPrompt } from '../src/agent/systemPrompt';
import { BrowserSession } from '../src/browser/session';
import { DesktopHost } from '../src/desktop/host';
import { createBrowserTools } from '../src/tools/browser';
import { createDesktopTools } from '../src/tools/desktop';
import { readFileTool, writeFileTool, editFileTool } from '../src/tools/files';
import { createTools } from '../src/tools';
import { formatDiagnostics, ideTools } from '../src/tools/ide';
import { BackgroundProcesses, detectShell } from '../src/tools/shell';
import { todoTool } from '../src/tools/todo';
import { Diagnostic, EditorState, IdeBridge, ToolContext } from '../src/tools/types';

let dir: string;

/** In-memory stand-in for the VS Code bridge; records what the tools asked it to do. */
class FakeIde implements IdeBridge {
  calls: string[] = [];
  problems: Diagnostic[] = [];

  async diagnostics(absPath?: string, waitMs?: number) {
    this.calls.push(`diagnostics ${absPath ? path.basename(absPath) : 'all'} ${waitMs}`);
    return absPath ? this.problems.filter((d) => d.path === absPath) : this.problems;
  }
  editorState(): EditorState {
    return {
      workspaceFolders: [dir],
      activeFile: path.join(dir, 'src', 'app.ts'),
      cursor: { line: 12, column: 4 },
      selection: { startLine: 10, endLine: 12, text: 'const total = items.length;' },
      openEditors: [path.join(dir, 'src', 'app.ts'), path.join(dir, 'README.md')],
      unsavedFiles: [path.join(dir, 'README.md')],
      terminals: ['bash'],
      debugSessions: [],
      problems: { errors: 1, warnings: 2 },
    };
  }
  async openFile(absPath: string, line?: number) {
    this.calls.push(`open ${path.basename(absPath)}:${line}`);
  }
  async listTasks() {
    return [{ name: 'build', source: 'npm', group: 'build' }, { name: 'test', source: 'npm' }];
  }
  async runTask(name: string, timeoutMs: number) {
    this.calls.push(`task ${name} ${timeoutMs}`);
    return name === 'watch' ? { timedOut: true } : { exitCode: 0, timedOut: false };
  }
  async startDebugging(config?: string) {
    return `Started debugging "${config ?? 'Launch'}".`;
  }
  async stopDebugging() {
    return 'Stopped the debug session.';
  }
  async executeCommand(command: string, args: unknown[]) {
    this.calls.push(`command ${command} ${JSON.stringify(args)}`);
    return command === 'test.answer' ? { answer: 42 } : undefined;
  }
}

let ide: FakeIde;
const ctx = (): ToolContext => ({
  cwd: dir,
  shell: detectShell(),
  background: new BackgroundProcesses(),
  signal: new AbortController().signal,
  readFiles: new Set(),
  ide,
});
const tool = (name: string) => ideTools.find((t) => t.name === name)!;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apexdev-ide-'));
  await fs.mkdir(path.join(dir, 'src'));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

describe('ide tools', () => {
  it('formats diagnostics errors first with relative paths', async () => {
    ide = new FakeIde();
    const file = path.join(dir, 'src', 'app.ts');
    ide.problems = [
      { path: file, line: 3, column: 1, severity: 'warning', message: 'unused variable', source: 'ts', code: 6133 as any },
      { path: file, line: 9, column: 5, severity: 'error', message: "Cannot find name 'totl'.", source: 'ts', code: '2304' },
    ];
    const out = String(await tool('ide_diagnostics').execute({ path: 'src/app.ts' }, ctx()));
    assert.match(out, /^1 error\(s\), 1 warning\(s\)/);
    assert.match(out.split('\n')[1], /src\/app\.ts:9:5 error \[ts 2304\]: Cannot find name 'totl'\./);
    assert.deepEqual(ide.calls, ['diagnostics app.ts 2000']);

    const errorsOnly = String(await tool('ide_diagnostics').execute({ include_warnings: false }, ctx()));
    assert.ok(!errorsOnly.includes('unused variable'));
    assert.equal(formatDiagnostics(dir, []), 'No problems.');
  });

  it('describes editor state including the selection', async () => {
    ide = new FakeIde();
    const out = String(await tool('ide_state').execute({}, ctx()));
    assert.match(out, /Active file: src\/app\.ts \(line 12, column 4\)/);
    assert.match(out, /const total = items\.length;/);
    assert.match(out, /Unsaved files: README\.md/);
    assert.match(out, /Problems: 1 error\(s\), 2 warning\(s\)/);
  });

  it('opens files, runs tasks, debugs and runs commands through the bridge', async () => {
    ide = new FakeIde();
    assert.match(String(await tool('open_file').execute({ path: 'src/app.ts', line: 7 }, ctx())), /Opened src\/app\.ts at line 7/);
    assert.match(String(await tool('ide_tasks').execute({}, ctx())), /build \(npm, build\)\ntest \(npm\)/);
    assert.match(String(await tool('run_task').execute({ name: 'build' }, ctx())), /exit code 0/);
    assert.match(String(await tool('run_task').execute({ name: 'watch', timeout_ms: 5000 }, ctx())), /still running/);
    assert.match(String(await tool('debug').execute({ action: 'start', config: 'Run Extension' }, ctx())), /Run Extension/);
    assert.match(String(await tool('vscode_command').execute({ command: 'test.answer', args: [1] }, ctx())), /"answer": 42/);
    assert.match(String(await tool('vscode_command').execute({ command: 'workbench.action.files.saveAll' }, ctx())), /^Executed workbench/);
    assert.deepEqual(ide.calls, [
      'open app.ts:7',
      'task build 300000',
      'task watch 5000',
      'command test.answer [1]',
      'command workbench.action.files.saveAll []',
    ]);
  });

  it('fails clearly without an IDE bridge', async () => {
    await assert.rejects(tool('ide_state').execute({}, { ...ctx(), ide: undefined }), /not available/);
  });

  it('appends new errors to write_file and edit_file results', async () => {
    ide = new FakeIde();
    const file = path.join(dir, 'src', 'broken.ts');
    ide.problems = [{ path: file, line: 1, column: 7, severity: 'error', message: "Type 'string' is not assignable to type 'number'." }];
    const c = ctx();
    const written = String(await writeFileTool.execute({ path: 'src/broken.ts', content: "const n: number = 'one';\n" }, c));
    assert.match(written, /VS Code now reports 1 error\(s\) in this file:\n {2}line 1:7 Type 'string'/);

    ide.problems = [];
    await readFileTool.execute({ path: 'src/broken.ts' }, c);
    const edited = String(await editFileTool.execute({ path: 'src/broken.ts', old_string: "'one'", new_string: '1' }, c));
    assert.ok(!edited.includes('VS Code now reports'));
  });
});

describe('todo_write', () => {
  it('validates and echoes the plan', async () => {
    const out = String(
      await todoTool.execute(
        {
          todos: [
            { content: 'Create index.html', status: 'completed' },
            { content: 'Style the page', status: 'in_progress' },
            { content: 'Check it in the browser', status: 'pending' },
          ],
        },
        ctx(),
      ),
    );
    assert.equal(out, 'Plan updated (1/3 done):\n[x] 1. Create index.html\n[~] 2. Style the page\n[ ] 3. Check it in the browser');
    assert.equal(todoTool.summarize({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }), '1/2 done');
    await assert.rejects(todoTool.execute({ todos: [{ content: 'x', status: 'doing' as any }] }, ctx()), /Invalid status/);
    await assert.rejects(todoTool.execute({ todos: [{ content: ' ', status: 'pending' }] }, ctx()), /non-empty/);
  });
});

describe('createTools / system prompt', () => {
  it('includes core, ide and plan tools, appends extras without duplicates', () => {
    const names = createTools().map((t) => t.name);
    for (const n of ['read_file', 'run_command', 'todo_write', 'ide_diagnostics', 'vscode_command']) assert.ok(names.includes(n), n);
    const withExtra = createTools([todoTool, { ...todoTool, name: 'extra_tool' }]).map((t) => t.name);
    assert.equal(withExtra.filter((n) => n === 'todo_write').length, 1);
    assert.equal(withExtra.at(-1), 'extra_tool');
    assert.equal(new Set(withExtra).size, withExtra.length);
  });

  it('adds capability sections and memories only when enabled', () => {
    const base = { cwd: dir, hasWorkspace: true, shellName: 'bash', model: 'm' };
    const plain = buildSystemPrompt(base);
    assert.ok(!plain.includes('# Browser') && !plain.includes('# Desktop') && !plain.includes('# Memory'));
    assert.match(plain, /todo_write/);
    const full = buildSystemPrompt({
      ...base,
      memories: '- (global, id ab12) Reply in Roman Urdu',
      projectInstructions: 'Use pnpm.',
      capabilities: { browser: true, desktop: true, subAgents: true, memory: true },
    });
    for (const s of ['# Browser', '# Desktop', '# Sub-agents', '# Memory', 'Reply in Roman Urdu', 'Use pnpm.']) assert.ok(full.includes(s), s);

    // Every tool the prompt names must exist, or the model will call tools that are not there.
    const names = new Set([
      ...createTools().map((t) => t.name),
      ...createBrowserTools(new BrowserSession({ profileDir: dir })).map((t) => t.name),
      ...createDesktopTools(new DesktopHost({ scriptPath: 'host.ps1', tempDir: dir })).map((t) => t.name),
    ]);
    const mentioned = new Set(full.match(/\b(?:browser|desktop|ide)_[a-z_]+[a-z]\b|\b(?:todo_write|open_file|run_task|vscode_command)\b/g));
    for (const name of mentioned) {
      if (name.startsWith('desktop_') && process.platform !== 'win32') continue;
      assert.ok(names.has(name), `system prompt mentions unknown tool ${name}`);
    }
  });
});
