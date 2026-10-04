import { promises as fs } from 'fs';
import * as path from 'path';

const MAX_FILE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_DIR_ENTRIES = 200;

/** `@path` tokens in a message; trailing punctuation is not part of the path. */
export function findMentions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const token = match[1].replace(/[),.;:!?'"]+$/, '');
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Adds the contents of files (or listings of folders) mentioned with `@path` to the message,
 * so the model sees them without spending a tool call. Unknown mentions are left as typed.
 */
export async function expandMentions(text: string, cwd: string): Promise<{ text: string; attached: string[] }> {
  const blocks: string[] = [];
  const attached: string[] = [];
  let total = 0;
  for (const mention of findMentions(text)) {
    const full = path.resolve(cwd, mention);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    const rel = path.relative(cwd, full).split(path.sep).join('/') || '.';
    if (stat.isDirectory()) {
      const entries = (await fs.readdir(full, { withFileTypes: true }))
        .filter((e) => !['.git', 'node_modules'].includes(e.name))
        .slice(0, MAX_DIR_ENTRIES)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      blocks.push(`<attached_folder path="${rel}">\n${entries.join('\n')}\n</attached_folder>`);
      attached.push(rel);
      continue;
    }
    if (!stat.isFile() || total >= MAX_TOTAL_CHARS) continue;
    const buffer = await fs.readFile(full);
    if (buffer.subarray(0, 8000).includes(0)) {
      blocks.push(`<attached_file path="${rel}">[binary file, ${stat.size} bytes — not shown]</attached_file>`);
      attached.push(rel);
      continue;
    }
    let content = buffer.toString('utf8');
    const limit = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total);
    if (content.length > limit) content = `${content.slice(0, limit)}\n… [truncated — ${content.length - limit} more characters; use read_file for the rest]`;
    total += content.length;
    blocks.push(`<attached_file path="${rel}">\n${content}\n</attached_file>`);
    attached.push(rel);
  }
  if (!blocks.length) return { text, attached };
  return {
    text: `${text}\n\nFiles the user attached with @ (current contents):\n${blocks.join('\n')}`,
    attached,
  };
}
