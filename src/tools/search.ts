import fg from 'fast-glob';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, ToolError, displayPath, resolvePath, throwIfAborted, truncateMiddle } from './types';

const IGNORE = ['**/node_modules/**', '**/.git/**'];
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: 'glob',
  label: 'Find',
  kind: 'read',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/index.*"). Returns paths sorted by most recently modified. ' +
    'node_modules and .git are skipped.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to path.' },
      path: { type: 'string', description: 'Directory to search in; defaults to the workspace root.' },
    },
    required: ['pattern'],
  },
  summarize: (i) => (i.path ? `${i.pattern} in ${i.path}` : i.pattern),
  async execute(input, ctx) {
    const base = resolvePath(ctx.cwd, input.path);
    const entries = await fg(input.pattern.replace(/\\/g, '/'), {
      cwd: base,
      ignore: IGNORE,
      dot: true,
      onlyFiles: true,
      stats: true,
      suppressErrors: true,
    });
    if (!entries.length) return 'No files matched.';
    entries.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    const limit = 200;
    const lines = entries.slice(0, limit).map((e) => displayPath(ctx.cwd, path.join(base, e.path)));
    if (entries.length > limit) lines.push(`… ${entries.length - limit} more files (narrow the pattern)`);
    return lines.join('\n');
  },
};

type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  output_mode?: 'content' | 'files' | 'count';
  context?: number;
};

export const grepTool: Tool<GrepInput> = {
  name: 'grep',
  label: 'Search',
  kind: 'read',
  description:
    'Search file contents with a JavaScript regular expression. output_mode "content" (default) returns ' +
    '"path:line: text" matches, "files" returns matching file paths, "count" returns match counts per file.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search; defaults to the workspace root.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "**/*.{ts,tsx}".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      output_mode: { type: 'string', enum: ['content', 'files', 'count'] },
      context: { type: 'integer', description: 'Lines of context before and after each match (content mode).' },
    },
    required: ['pattern'],
  },
  summarize: (i) => `/${i.pattern}/` + (i.glob ? ` in ${i.glob}` : i.path ? ` in ${i.path}` : ''),
  async execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
    }

    const target = resolvePath(ctx.cwd, input.path);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new ToolError(`Path not found: ${input.path}`);
    const files = stat.isFile()
      ? [target]
      : (
          await fg((input.glob ?? '**/*').replace(/\\/g, '/'), {
            cwd: target,
            ignore: IGNORE,
            dot: true,
            onlyFiles: true,
            absolute: true,
            suppressErrors: true,
          })
        ).map((f) => path.normalize(f));

    const mode = input.output_mode ?? 'content';
    const context = Math.min(Math.max(input.context ?? 0, 0), 10);
    const maxLines = 300;
    const out: string[] = [];
    let matchedFiles = 0;
    let truncated = false;

    for (const file of files) {
      throwIfAborted(ctx.signal);
      const fstat = await fs.stat(file).catch(() => null);
      if (!fstat || fstat.size > MAX_GREP_FILE_BYTES) continue;
      const buffer = await fs.readFile(file).catch(() => null);
      if (!buffer || buffer.subarray(0, 8000).includes(0)) continue;

      const lines = buffer.toString('utf8').split(/\r?\n/);
      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) hits.push(i);
      if (!hits.length) continue;
      matchedFiles++;
      const shown = displayPath(ctx.cwd, file);

      if (mode === 'files') out.push(shown);
      else if (mode === 'count') out.push(`${shown}: ${hits.length}`);
      else {
        let last = -1;
        for (const hit of hits) {
          const from = Math.max(hit - context, last + 1);
          const to = Math.min(hit + context, lines.length - 1);
          if (context && last >= 0 && from > last + 1) out.push('--');
          for (let i = from; i <= to; i++) {
            const text = lines[i].length > 500 ? lines[i].slice(0, 500) + '…' : lines[i];
            out.push(`${shown}:${i + 1}${i === hit ? ':' : '-'} ${text}`);
          }
          last = to;
        }
      }
      if (out.length >= maxLines) {
        truncated = true;
        break;
      }
    }

    if (!out.length) return 'No matches found.';
    let result = out.slice(0, maxLines).join('\n');
    if (truncated) result += `\n… results truncated after ${matchedFiles} files — narrow the pattern, path or glob.`;
    return truncateMiddle(result);
  },
};
