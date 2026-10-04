import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface Memory {
  id: string;
  text: string;
  scope: 'global' | 'workspace';
  /** Workspace folder the memory belongs to (workspace scope only). */
  workspace?: string;
  created: string;
}

const MAX_MEMORIES = 200;
const MAX_TEXT = 1000;

function sameFolder(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** Facts the agent keeps across chats: user preferences (global) and project notes (per workspace). */
export class MemoryStore {
  private cache?: Memory[];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async all(): Promise<Memory[]> {
    if (!this.cache) {
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
        this.cache = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.cache = [];
      }
    }
    return this.cache!;
  }

  /** Global memories plus the ones for this workspace. */
  async relevant(workspace?: string): Promise<Memory[]> {
    return (await this.all()).filter((m) => m.scope === 'global' || sameFolder(m.workspace, workspace));
  }

  async add(text: string, scope: Memory['scope'], workspace?: string): Promise<Memory> {
    const clean = text.trim().slice(0, MAX_TEXT);
    const memories = await this.all();
    const existing = memories.find((m) => m.text === clean && m.scope === scope && (scope === 'global' || sameFolder(m.workspace, workspace)));
    if (existing) return existing;
    const memory: Memory = {
      id: randomBytes(4).toString('hex'),
      text: clean,
      scope,
      workspace: scope === 'workspace' ? workspace : undefined,
      created: new Date().toISOString(),
    };
    memories.push(memory);
    if (memories.length > MAX_MEMORIES) memories.splice(0, memories.length - MAX_MEMORIES);
    await this.save();
    return memory;
  }

  async remove(id: string): Promise<boolean> {
    const memories = await this.all();
    const index = memories.findIndex((m) => m.id === id);
    if (index < 0) return false;
    memories.splice(index, 1);
    await this.save();
    return true;
  }

  /** Section for the system prompt, newest last, capped so it never crowds out the task. */
  async promptSection(workspace?: string, maxChars = 6000): Promise<string> {
    const memories = await this.relevant(workspace);
    if (!memories.length) return '';
    const lines: string[] = [];
    let size = 0;
    for (const m of memories.slice().reverse()) {
      const line = `- (${m.scope}, id ${m.id}) ${m.text}`;
      if (size + line.length > maxChars) break;
      lines.unshift(line);
      size += line.length;
    }
    return lines.join('\n');
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.cache ?? [], null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }
}
