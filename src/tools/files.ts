import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolError, displayPath, fileKey, resolvePath } from './types';

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/** After a change, report errors the editor's language server now sees in that file. */
async function problemsAfterEdit(ctx: ToolContext, abs: string): Promise<string> {
  if (!ctx.ide) return '';
  try {
    const errors = (await ctx.ide.diagnostics(abs, 1500)).filter((d) => d.severity === 'error');
    if (!errors.length) return '';
    const shown = errors.slice(0, 10).map((d) => `  line ${d.line}:${d.column} ${d.message}`);
    return `\n\nVS Code now reports ${errors.length} error(s) in this file:\n${shown.join('\n')}`;
  } catch {
    return '';
  }
}

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  label: 'Read',
  kind: 'read',
  description:
    'Read a text file. Output has line numbers ("   12\\tcode"); the numbers are NOT part of the file. ' +
    `Reads up to ${DEFAULT_LINE_LIMIT} lines by default — use offset/limit for large files.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the workspace root.' },
      offset: { type: 'integer', description: '1-based line number to start reading from.' },
      limit: { type: 'integer', description: 'Number of lines to read.' },
    },
    required: ['path'],
  },
  summarize: (i) => i.path + (i.offset ? `:${i.offset}` : ''),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const stat = await statOrNull(abs);
    if (!stat) throw new ToolError(`File not found: ${input.path}`);
    if (stat.isDirectory()) throw new ToolError(`${input.path} is a directory. Use list_dir instead.`);
    if (stat.size > MAX_FILE_BYTES) throw new ToolError(`File is too large (${stat.size} bytes). Use grep to find the relevant part.`);

    const buffer = await fs.readFile(abs);
    if (isBinary(buffer)) return `(binary file, ${stat.size} bytes — not shown)`;
    ctx.readFiles.add(fileKey(abs));

    const text = buffer.toString('utf8');
    if (!text.length) return '(empty file)';
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, (input.offset ?? 1) - 1);
    if (start >= lines.length) throw new ToolError(`offset ${input.offset} is past the end of the file (${lines.length} lines).`);
    const end = Math.min(lines.length, start + Math.max(1, input.limit ?? DEFAULT_LINE_LIMIT));

    const out: string[] = [];
    for (let i = start; i < end; i++) {
      let line = lines[i];
      if (line.length > MAX_LINE_LENGTH) line = line.slice(0, MAX_LINE_LENGTH) + ' …[line truncated]';
      out.push(`${String(i + 1).padStart(6)}\t${line}`);
    }
    if (end < lines.length) {
      out.push(`\n(${lines.length - end} more lines — call read_file with offset=${end + 1} to continue)`);
    }
    return out.join('\n');
  },
};

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  label: 'Write',
  kind: 'edit',
  description:
    'Create a new file or completely replace an existing one. Parent folders are created automatically. ' +
    'An existing file must be read with read_file first. Prefer edit_file for changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the workspace root.' },
      content: { type: 'string', description: 'The full file content.' },
    },
    required: ['path', 'content'],
  },
  summarize: (i) => i.path,
  async execute(input, ctx) {
    if (typeof input.content !== 'string') throw new ToolError('content must be a string.');
    const abs = resolvePath(ctx.cwd, input.path);
    const stat = await statOrNull(abs);
    if (stat?.isDirectory()) throw new ToolError(`${input.path} is a directory.`);
    if (stat && !ctx.readFiles.has(fileKey(abs))) {
      throw new ToolError(`${input.path} already exists. Read it with read_file before overwriting it.`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, 'utf8');
    ctx.readFiles.add(fileKey(abs));
    const lineCount = input.content.split('\n').length;
    return `${stat ? 'Overwrote' : 'Created'} ${displayPath(ctx.cwd, abs)} (${lineCount} lines).${await problemsAfterEdit(ctx, abs)}`;
  },
};

export const editFileTool: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  name: 'edit_file',
  label: 'Edit',
  kind: 'edit',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation, without ' +
    'read_file line-number prefixes) and be unique unless replace_all is true. Include enough surrounding lines to ' +
    'make it unique. The file must have been read with read_file first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text (must differ from old_string).' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  summarize: (i) => i.path,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const stat = await statOrNull(abs);
    if (!stat) throw new ToolError(`File not found: ${input.path}. Use write_file to create it.`);
    if (!ctx.readFiles.has(fileKey(abs))) throw new ToolError(`Read ${input.path} with read_file before editing it.`);
    if (!input.old_string) throw new ToolError('old_string is empty. Use write_file to create or replace a whole file.');
    if (input.old_string === input.new_string) throw new ToolError('old_string and new_string are identical.');

    const original = await fs.readFile(abs, 'utf8');
    let oldText = input.old_string;
    let newText = input.new_string;
    // Models usually send LF; match files that use CRLF.
    if (!original.includes(oldText) && original.includes('\r\n')) {
      oldText = oldText.replace(/\r?\n/g, '\r\n');
      newText = newText.replace(/\r?\n/g, '\r\n');
    }

    const count = original.split(oldText).length - 1;
    if (count === 0) {
      throw new ToolError(
        `old_string was not found in ${input.path}. Re-read the file and copy the text exactly (whitespace matters).`,
      );
    }
    if (count > 1 && !input.replace_all) {
      throw new ToolError(
        `old_string occurs ${count} times in ${input.path}. Add more surrounding context to make it unique, or set replace_all.`,
      );
    }
    const updated = input.replace_all ? original.split(oldText).join(newText) : original.replace(oldText, () => newText);
    await fs.writeFile(abs, updated, 'utf8');

    const before = original.split('\n').length;
    const after = updated.split('\n').length;
    const delta = after - before;
    const lines = delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${delta} lines)`;
    return `Edited ${displayPath(ctx.cwd, abs)}: replaced ${input.replace_all ? count : 1} occurrence(s)${lines}.${await problemsAfterEdit(ctx, abs)}`;
  },
};

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  label: 'List',
  kind: 'read',
  description: 'List the entries of a directory (not recursive). Folders end with "/".',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path; defaults to the workspace root.' },
    },
  },
  summarize: (i) => i.path || '.',
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const stat = await statOrNull(abs);
    if (!stat) throw new ToolError(`Directory not found: ${input.path ?? '.'}`);
    if (!stat.isDirectory()) throw new ToolError(`${input.path} is a file. Use read_file instead.`);

    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const limit = 500;
    const lines = entries.slice(0, limit).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (!lines.length) return '(empty directory)';
    if (entries.length > limit) lines.push(`… and ${entries.length - limit} more entries`);
    return lines.join('\n');
  },
};
