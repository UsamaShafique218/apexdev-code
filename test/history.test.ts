import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ChatRecord, ChatStore, chatTitle } from '../src/history/store';

let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apexdev-history-'));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

function record(id: string, updated: string, workspace = 'D:\\proj'): ChatRecord {
  return {
    id,
    title: `Chat ${id}`,
    created: updated,
    updated,
    workspace,
    messages: [
      { role: 'user', content: 'Take a screenshot' },
      { role: 'user', content: [{ type: 'text', text: '[Screenshots]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'Done.' },
    ],
    transcript: [
      { type: 'user', text: 'Take a screenshot' },
      { type: 'toolEnd', id: 't1', output: 'x'.repeat(10_000), isError: false, images: ['data:image/png;base64,AAAA'] },
      { type: 'text', delta: 'Done.' },
    ],
  };
}

describe('ChatStore', () => {
  it('saves, lists newest first, filters by workspace and loads', async () => {
    const store = new ChatStore(path.join(dir, 'chats'));
    await Promise.all([
      store.save(record('a1', '2026-10-01T10:00:00.000Z')),
      store.save(record('b2', '2026-10-03T10:00:00.000Z')),
      store.save(record('c3', '2026-10-02T10:00:00.000Z', 'D:\\other')),
    ]);
    assert.deepEqual((await store.list()).map((c) => c.id), ['b2', 'c3', 'a1']);
    assert.deepEqual((await store.list('D:\\proj')).map((c) => c.id), ['b2', 'a1']);

    const loaded = (await store.load('a1'))!;
    assert.equal(loaded.title, 'Chat a1');
    assert.equal(loaded.messages.length, 3);
  });

  it('strips images and trims long tool output before writing', async () => {
    const store = new ChatStore(path.join(dir, 'chats'));
    const loaded = (await store.load('a1'))!;
    const raw = await fs.readFile(path.join(dir, 'chats', 'a1.json'), 'utf8');
    assert.ok(!raw.includes('base64'), 'no image data on disk');
    assert.deepEqual(loaded.messages[1].content, [
      { type: 'text', text: '[Screenshots]' },
      { type: 'text', text: '[screenshot not kept in saved chats]' },
    ]);
    const toolEnd = loaded.transcript[1] as any;
    assert.ok(toolEnd.output.length < 7000 && toolEnd.output.endsWith('(trimmed in saved chat)'));
    assert.equal(toolEnd.imageCount, 1);
    assert.equal(toolEnd.images, undefined);
  });

  it('updates in place, deletes, and survives a fresh instance', async () => {
    const store = new ChatStore(path.join(dir, 'chats'));
    await store.save({ ...record('a1', '2026-10-04T09:00:00.000Z'), title: 'Renamed' });
    await store.delete('c3');
    const reopened = new ChatStore(path.join(dir, 'chats'));
    const list = await reopened.list();
    assert.deepEqual(list.map((c) => [c.id, c.title]), [['a1', 'Renamed'], ['b2', 'Chat b2']]);
    assert.equal(await reopened.load('c3'), undefined);
    assert.equal(await reopened.load('../escape'), undefined);
  });

  it('builds short titles', () => {
    assert.equal(chatTitle('  Build a\n landing page  '), 'Build a landing page');
    assert.equal(chatTitle('x'.repeat(100)).length, 58);
    assert.equal(chatTitle('   '), 'New chat');
  });
});
