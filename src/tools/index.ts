import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files';
import { ideTools } from './ide';
import { globTool, grepTool } from './search';
import { commandOutputTool, runCommandTool } from './shell';
import { todoTool } from './todo';
import type { Tool } from './types';
import type { ToolSchema } from '../llm/types';

/** Core tools that are always available; optional groups (memory, sub-agents, browser, desktop) come in as `extra`. */
export function createTools(extra: Tool[] = []): Tool[] {
  const tools = [
    readFileTool,
    listDirTool,
    globTool,
    grepTool,
    editFileTool,
    writeFileTool,
    runCommandTool,
    commandOutputTool,
    todoTool,
    ...ideTools,
    ...extra,
  ];
  const seen = new Set<string>();
  return tools.filter((t) => !seen.has(t.name) && seen.add(t.name));
}

export function toToolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
