import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MemoryStore } from '../src/memory/store';
import { createMemoryTool } from '../src/tools/memory';
import { BackgroundProcesses, detectShell } from '../src/tools/shell';
import { ToolContext } from '../src/tools/types';

let dir: string;
const projA = path.join(os.tmpdir(), 'project-a');
const projB = path.join(os.tmpdir(), 'project-b');

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apexdev-memory-'));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

const ctx = (): ToolContext => ({
  cwd: projA,
  shell: detectShell(),
  background: new BackgroundProcesses(),
  signal: new AbortController().signal,
  readFiles: new Set(),
});

describe('MemoryStore', () => {
  it('keeps global and per-workspace memories apart and persists them', async () => {
    const file = path.join(dir, 'memory.json');
    const store = new MemoryStore(file);
    await store.add('User prefers replies in Roman Urdu', 'global');
    await store.add('Project A uses pnpm', 'workspace', projA);
    await store.add('Project B deploys to Fly.io', 'workspace', projB);
    const again = await store.add('Project A uses pnpm', 'workspace', projA + path.sep);
    assert.equal((await store.all()).length, 3, 'duplicate (even with a trailing slash) is not added twice');

    const forA = (await store.relevant(projA)).map((m) => m.text);
    assert.deepEqual(forA, ['User prefers replies in Roman Urdu', 'Project A uses pnpm']);

    const reopened = new MemoryStore(file);
    assert.equal((await reopened.all()).length, 3);
    const section = await reopened.promptSection(projA);
    assert.match(section, /^- \(global, id [0-9a-f]{8}\) User prefers replies in Roman Urdu\n- \(workspace, id [0-9a-f]{8}\) Project A uses pnpm$/);
    assert.ok(!section.includes('Fly.io'));

    assert.equal(await reopened.remove(again.id), true);
    assert.equal(await reopened.remove('nope'), false);
    assert.equal((await new MemoryStore(file).relevant(projA)).length, 1);
  });

  it('caps the prompt section, keeping the newest memories', async () => {
    const store = new MemoryStore(path.join(dir, 'cap.json'));
    for (let i = 0; i < 10; i++) await store.add(`fact number ${i} ${'x'.repeat(80)}`, 'global');
    const section = await store.promptSection(undefined, 400);
    assert.ok(section.length <= 400);
    assert.match(section, /fact number 9/);
    assert.ok(!section.includes('fact number 0'));
  });
});

describe('memory tool', () => {
  it('saves, lists and deletes through the tool', async () => {
    const store = new MemoryStore(path.join(dir, 'tool.json'));
    const tool = createMemoryTool(store, () => projA);
    const saved = String(await tool.execute({ action: 'save', text: 'Always run npm test before finishing' }, ctx()));
    const id = saved.match(/Saved memory ([0-9a-f]+) \(workspace\)/)![1];
    await tool.execute({ action: 'save', text: 'User name is Ali', scope: 'global' }, ctx());
    const list = String(await tool.execute({ action: 'list' }, ctx()));
    assert.match(list, new RegExp(`${id} \\(workspace\\) Always run npm test`));
    assert.match(list, /\(global\) User name is Ali/);
    assert.match(String(await tool.execute({ action: 'delete', id }, ctx())), /Deleted/);
    assert.ok(!String(await tool.execute({ action: 'list' }, ctx())).includes('npm test'));
  });

  it('refuses secrets and workspace memories without a folder', async () => {
    const store = new MemoryStore(path.join(dir, 'tool2.json'));
    await assert.rejects(createMemoryTool(store, () => projA).execute({ action: 'save', text: 'api_key = sk-abcdefghijklmnop' }, ctx()), /secret/);
    await assert.rejects(createMemoryTool(store, () => undefined).execute({ action: 'save', text: 'Uses tabs' }, ctx()), /No folder is open/);
    assert.equal(String(await createMemoryTool(store, () => undefined).execute({ action: 'list' }, ctx())), 'No memories yet.');
  });
});
