import { promises as fs } from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../llm/types';

export interface ChatSummary {
  id: string;
  title: string;
  created: string;
  updated: string;
  workspace?: string;
}

/** A UI event as posted to the webview; replayed to redraw a saved chat. */
export type TranscriptEvent = { type: string } & Record<string, unknown>;

export interface ChatRecord extends ChatSummary {
  messages: ChatMessage[];
  transcript: TranscriptEvent[];
}

const MAX_CHATS = 100;
const MAX_STORED_OUTPUT = 6000;

/** Saved chats: one JSON file per chat plus a small index for listing. */
export class ChatStore {
  private index?: ChatSummary[];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async list(workspace?: string): Promise<ChatSummary[]> {
    const all = (await this.readIndex()).slice().sort((a, b) => b.updated.localeCompare(a.updated));
    return workspace === undefined ? all : all.filter((c) => c.workspace === workspace);
  }

  async load(id: string): Promise<ChatRecord | undefined> {
    if (!/^[\w-]+$/.test(id)) return undefined;
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as ChatRecord;
    } catch {
      return undefined;
    }
  }

  save(record: ChatRecord): Promise<void> {
    const stored: ChatRecord = {
      ...record,
      messages: record.messages.map(stripImages),
      transcript: record.transcript.map(slimEvent),
    };
    return this.enqueue(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await writeAtomic(this.file(record.id), JSON.stringify(stored));
      const index = await this.readIndex();
      const summary: ChatSummary = {
        id: record.id,
        title: record.title,
        created: record.created,
        updated: record.updated,
        workspace: record.workspace,
      };
      const at = index.findIndex((c) => c.id === record.id);
      if (at >= 0) index[at] = summary;
      else index.push(summary);
      index.sort((a, b) => b.updated.localeCompare(a.updated));
      for (const old of index.splice(MAX_CHATS)) await fs.rm(this.file(old.id), { force: true });
      await this.writeIndex(index);
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      const at = index.findIndex((c) => c.id === id);
      if (at >= 0) index.splice(at, 1);
      await fs.rm(this.file(id), { force: true });
      await this.writeIndex(index);
    });
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async readIndex(): Promise<ChatSummary[]> {
    if (!this.index) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8'));
        this.index = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.index = [];
      }
    }
    return this.index!;
  }

  private async writeIndex(index: ChatSummary[]): Promise<void> {
    this.index = index;
    await writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(index, null, 2));
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writing.then(job, job);
    this.writing = next.catch(() => undefined);
    return next;
  }
}

/** Chat title from the first user message. */
export function chatTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}

function stripImages(m: ChatMessage): ChatMessage {
  if (m.role !== 'user' || typeof m.content === 'string') return m;
  return {
    role: 'user',
    content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: '[screenshot not kept in saved chats]' } : p)),
  };
}

function slimEvent(e: TranscriptEvent): TranscriptEvent {
  if (e.type !== 'toolEnd') return e;
  const { images, ...rest } = e as TranscriptEvent & { images?: unknown[]; output?: string };
  const output = typeof rest.output === 'string' && rest.output.length > MAX_STORED_OUTPUT
    ? `${rest.output.slice(0, MAX_STORED_OUTPUT)}\n… (trimmed in saved chat)`
    : rest.output;
  return { ...rest, output, imageCount: Array.isArray(images) ? images.length : undefined };
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}
