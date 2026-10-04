import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as files from '../src/tools/files';
import * as search from '../src/tools/search';
import * as shell from '../src/tools/shell';
import { BackgroundProcesses, detectShell, isDangerousCommand } from '../src/tools/shell';
import { Tool, ToolContext, resolvePath } from '../src/tools/types';

/** These tools only ever return text; narrow the type so assertions can use it directly. */
const textTool = <I>(t: Tool<I>) => t as unknown as { execute(input: I, ctx: ToolContext): Promise<string> };
const readFileTool = textTool(files.readFileTool);
const editFileTool = textTool(files.editFileTool);
const writeFileTool = textTool(files.writeFileTool);
const listDirTool = textTool(files.listDirTool);
const globTool = textTool(search.globTool);
const grepTool = textTool(search.grepTool);
const runCommandTool = textTool(shell.runCommandTool);
const commandOutputTool = textTool(shell.commandOutputTool);

let dir: string;
let ctx: ToolContext;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'apexdev-test-'));
  await fs.mkdir(path.join(dir, 'src', 'lib'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'import { add } from "./lib/math";\nconsole.log(add(1, 2));\n');
  await fs.writeFile(path.join(dir, 'src', 'lib', 'math.ts'), 'export function add(a: number, b: number) {\r\n  return a + b;\r\n}\r\n');
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'export function add() {}\n');
  await fs.writeFile(path.join(dir, 'README.md'), '# Demo\nTODO: write docs\n');
  ctx = {
    cwd: dir,
    signal: new AbortController().signal,
    shell: detectShell('auto'),
    background: new BackgroundProcesses(),
    readFiles: new Set(),
  };
});

after(() => {
  ctx.background.killAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('paths', () => {
  it('resolves relative, absolute and Git Bash style paths', () => {
    assert.equal(resolvePath(dir, 'src/index.ts'), path.join(dir, 'src', 'index.ts'));
    assert.equal(resolvePath(dir, undefined), dir);
    if (process.platform === 'win32') assert.equal(resolvePath(dir, '/c/Windows'), 'C:\\Windows');
  });
});

describe('read_file', () => {
  it('returns numbered lines and supports offset/limit', async () => {
    const out = await readFileTool.execute({ path: 'src/lib/math.ts', offset: 2, limit: 1 }, ctx);
    assert.match(out, /^\s+2\t {2}return a \+ b;/);
    assert.match(out, /more lines/);
  });

  it('rejects missing files and directories', async () => {
    await assert.rejects(readFileTool.execute({ path: 'nope.ts' }, ctx), /not found/);
    await assert.rejects(readFileTool.execute({ path: 'src' }, ctx), /directory/);
  });
});

describe('edit_file / write_file', () => {
  it('requires a read before editing', async () => {
    await fs.writeFile(path.join(dir, 'fresh.txt'), 'hello\n');
    await assert.rejects(
      editFileTool.execute({ path: 'fresh.txt', old_string: 'hello', new_string: 'bye' }, ctx),
      /Read fresh\.txt/,
    );
    await assert.rejects(writeFileTool.execute({ path: 'fresh.txt', content: 'x' }, ctx), /Read it with read_file/);
  });

  it('edits CRLF files with LF old_string and keeps CRLF', async () => {
    await readFileTool.execute({ path: 'src/lib/math.ts' }, ctx);
    const out = await editFileTool.execute(
      { path: 'src/lib/math.ts', old_string: 'export function add(a: number, b: number) {\n  return a + b;', new_string: 'export function add(a: number, b: number) {\n  // sum\n  return a + b;' },
      ctx,
    );
    assert.match(out, /\+1 lines/);
    const text = await fs.readFile(path.join(dir, 'src', 'lib', 'math.ts'), 'utf8');
    assert.equal(text, 'export function add(a: number, b: number) {\r\n  // sum\r\n  return a + b;\r\n}\r\n');
  });

  it('refuses ambiguous replacements unless replace_all', async () => {
    await fs.writeFile(path.join(dir, 'dup.txt'), 'a\na\n');
    await readFileTool.execute({ path: 'dup.txt' }, ctx);
    await assert.rejects(editFileTool.execute({ path: 'dup.txt', old_string: 'a', new_string: 'b' }, ctx), /occurs 2 times/);
    await editFileTool.execute({ path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true }, ctx);
    assert.equal(await fs.readFile(path.join(dir, 'dup.txt'), 'utf8'), 'b\nb\n');
  });

  it('creates new files with parent folders', async () => {
    const out = await writeFileTool.execute({ path: 'new/deep/file.txt', content: 'one\ntwo' }, ctx);
    assert.match(out, /Created new\/deep\/file\.txt \(2 lines\)/);
  });
});

describe('search', () => {
  it('list_dir puts folders first', async () => {
    const out = await listDirTool.execute({}, ctx);
    assert.equal(out.split('\n')[0].endsWith('/'), true);
    assert.match(out, /README\.md/);
  });

  it('glob skips node_modules', async () => {
    const out = await globTool.execute({ pattern: '**/*.{ts,js}' }, ctx);
    assert.match(out, /src\/index\.ts/);
    assert.doesNotMatch(out, /node_modules/);
  });

  it('grep finds content with line numbers', async () => {
    const out = await grepTool.execute({ pattern: 'function add' }, ctx);
    assert.match(out, /src\/lib\/math\.ts:1: export function add/);
    assert.doesNotMatch(out, /node_modules/);
    assert.equal(await grepTool.execute({ pattern: 'todo', ignore_case: true, output_mode: 'files' }, ctx), 'README.md');
    await assert.rejects(grepTool.execute({ pattern: '(' }, ctx), /Invalid regular expression/);
  });
});

describe('run_command', () => {
  it('captures output and exit code', async () => {
    const out = await runCommandTool.execute({ command: 'node -e "console.log(40 + 2); process.exit(3)"' }, ctx);
    assert.match(out, /42/);
    assert.match(out, /\[exit code: 3\]/);
  });

  it('times out long commands', async () => {
    const out = await runCommandTool.execute({ command: 'node -e "setTimeout(() => {}, 20000)"', timeout_ms: 1000 }, ctx);
    assert.match(out, /timed out/);
  });

  it('runs background processes and reads their output', async () => {
    const started = await runCommandTool.execute(
      { command: 'node -e "console.log(\'ready\'); setInterval(() => console.log(\'tick\'), 300)"', background: true },
      ctx,
    );
    assert.match(started, /background process #1/);
    assert.match(started, /ready/);
    await new Promise((r) => setTimeout(r, 700));
    assert.match(await commandOutputTool.execute({ id: 1 }, ctx), /tick[\s\S]*still running/);
    assert.match(await commandOutputTool.execute({ id: 1, kill: true }, ctx), /exited/);
  });

  it('flags destructive commands', () => {
    assert.equal(isDangerousCommand('rm -rf build'), true);
    assert.equal(isDangerousCommand('git push origin main'), true);
    assert.equal(isDangerousCommand('Remove-Item dist -Recurse -Force'), true);
    assert.equal(isDangerousCommand('npm test'), false);
    assert.equal(isDangerousCommand('git status'), false);
  });
});
