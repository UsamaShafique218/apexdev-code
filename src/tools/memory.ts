import type { MemoryStore } from '../memory/store';
import { Tool, ToolError } from './types';

interface MemoryInput {
  action: 'save' | 'list' | 'delete';
  text?: string;
  scope?: 'global' | 'workspace';
  id?: string;
}

export function createMemoryTool(store: MemoryStore, workspace: () => string | undefined): Tool<MemoryInput> {
  return {
    name: 'memory',
    label: 'Memory',
    kind: 'read',
    description:
      'Your persistent memory across chats. Saved memories appear in your instructions in every future chat. ' +
      'Save durable facts only: user preferences and corrections ("always use pnpm", "reply in Roman Urdu"), ' +
      'project conventions or decisions that are not obvious from the code. Do not save secrets, temporary task state ' +
      'or things already written in the repository. scope "global" = about the user (all projects), "workspace" = this project only. ' +
      'Delete memories that turn out to be wrong.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete'] },
        text: { type: 'string', description: 'The fact to remember (one fact, one or two sentences).' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: 'Default: workspace.' },
        id: { type: 'string', description: 'Memory id to delete.' },
      },
      required: ['action'],
    },
    summarize: (i) => (i.action === 'save' ? i.text ?? '' : i.action === 'delete' ? `delete ${i.id ?? ''}` : 'list'),
    async execute(input) {
      switch (input.action) {
        case 'save': {
          if (!input.text?.trim()) throw new ToolError('text is required to save a memory.');
          if (/\b(sk-[a-z0-9]{10,}|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=])/i.test(input.text)) {
            throw new ToolError('This looks like a secret. Never store secrets in memory.');
          }
          const scope = input.scope ?? 'workspace';
          const ws = workspace();
          if (scope === 'workspace' && !ws) throw new ToolError('No folder is open — use scope "global" or skip saving.');
          const m = await store.add(input.text, scope, ws);
          return `Saved memory ${m.id} (${m.scope}).`;
        }
        case 'delete': {
          if (!input.id) throw new ToolError('id is required to delete a memory.');
          return (await store.remove(input.id)) ? `Deleted memory ${input.id}.` : `No memory with id ${input.id}.`;
        }
        case 'list': {
          const memories = await store.relevant(workspace());
          if (!memories.length) return 'No memories yet.';
          return memories.map((m) => `${m.id} (${m.scope}) ${m.text}`).join('\n');
        }
        default:
          throw new ToolError('action must be save, list or delete.');
      }
    },
  };
}
