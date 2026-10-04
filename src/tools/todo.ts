import { Tool, ToolError } from './types';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

/** The plan lives in the UI (rendered from the tool input); the tool only validates and echoes it. */
export const todoTool: Tool<{ todos: Todo[] }> = {
  name: 'todo_write',
  label: 'Plan',
  kind: 'read',
  description:
    'Create or update the task plan shown to the user as a live checklist. Use it for any task with 3+ steps: ' +
    'write the full list up front, keep exactly one item "in_progress" while you work on it, and mark items "completed" ' +
    'as soon as they are done (send the whole list every time). Skip it for trivial one-step requests.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete, ordered list of steps.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short imperative description, e.g. "Add the login form".' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summarize: (i) => {
    const todos = Array.isArray(i.todos) ? i.todos : [];
    return `${todos.filter((t) => t.status === 'completed').length}/${todos.length} done`;
  },
  async execute(input) {
    if (!Array.isArray(input.todos)) throw new ToolError('todos must be an array.');
    for (const t of input.todos) {
      if (!t || typeof t.content !== 'string' || !t.content.trim()) throw new ToolError('Every todo needs a non-empty content.');
      if (!(t.status in MARK)) throw new ToolError(`Invalid status "${t.status}". Use pending, in_progress or completed.`);
    }
    const active = input.todos.filter((t) => t.status === 'in_progress').length;
    const done = input.todos.filter((t) => t.status === 'completed').length;
    const list = input.todos.map((t, i) => `${MARK[t.status]} ${i + 1}. ${t.content}`).join('\n');
    const note = active > 1 ? '\nNote: keep only one item in_progress at a time.' : '';
    return `Plan updated (${done}/${input.todos.length} done):\n${list}${note}`;
  },
};
