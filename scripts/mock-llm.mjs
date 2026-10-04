// Fake OpenAI-compatible server for trying the extension without an API key.
// Usage: npm run mock   →  set apexdev.baseUrl to http://127.0.0.1:8787/v1
// The scenario is picked from the latest user message:
//   - mentions a page / html / website → plan → write index.html → open it in the browser → screenshot → summary
//   - mentions research / sub-agent    → delegate to a sub-agent with the task tool → summary
//   - anything else                    → list the workspace → run `node --version` → summary
import { createServer } from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 8787);

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

function* textStream(text) {
  for (const piece of text.match(/[\s\S]{1,6}/g)) yield chunk({ content: piece });
  yield chunk({}, 'stop');
}

let callSeq = 0;
function* toolStream(text, name, args) {
  if (text) yield* [...textStream(text)].slice(0, -1);
  const id = `call_${++callSeq}`;
  yield chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  yield chunk({}, 'tool_calls');
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hello from ApexDev</title>
  <style>
    :root { --ink: #1c1917; --muted: #57534e; --paper: #fafaf9; --accent: #0f766e; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--paper);
      color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width: 560px; padding: 48px 24px; }
    p.eyebrow { margin: 0 0 8px; color: var(--accent); font-weight: 600; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0 0 16px; font-size: 40px; line-height: 1.1; letter-spacing: -0.02em; }
    p { margin: 0; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Generated locally</p>
    <h1>Hello from ApexDev</h1>
    <p>This page was written by the mock model to exercise the plan panel, file writes and browser tools.</p>
  </main>
</body>
</html>
`;

const plan = (done) =>
  ['Write index.html', 'Open it in the browser', 'Check the rendered page'].map((content, i) => ({
    content,
    status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
  }));

function workspaceRoot(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  return /Workspace root: (.+?)(?: \(|$)/m.exec(system)?.[1]?.trim() ?? process.cwd();
}

function pageScenario(messages, done) {
  const n = done.length;
  if (n === 0) return toolStream("I'll build a small landing page and check it in the browser.", 'todo_write', { todos: plan(0) });
  if (n === 1) return toolStream('', 'write_file', { path: 'index.html', content: PAGE });
  if (n === 2) return toolStream('', 'todo_write', { todos: plan(1) });
  if (n === 3) return toolStream('', 'browser_navigate', { url: pathToFileURL(path.join(workspaceRoot(messages), 'index.html')).href });
  if (n === 4) return toolStream('', 'todo_write', { todos: plan(2) });
  if (n === 5) return toolStream('', 'browser_screenshot', {});
  if (n === 6) return toolStream('', 'todo_write', { todos: plan(3) });
  return textStream(
    '## Done\n\n' +
      '- Created `index.html` — a single self-contained page with inline CSS.\n' +
      '- Opened it in the browser and took a screenshot to confirm it renders.\n\n' +
      'Open it any time with **Open index.html** on the write card above.',
  );
}

function researchScenario(done) {
  if (done.length === 0)
    return toolStream("I'll hand the research to a sub-agent so it can search without filling this chat.", 'task', {
      description: 'Map the source folders',
      prompt: 'List the top-level folders of the workspace and report what each one contains, in one short bullet each.',
    });
  return textStream('## Report\n\nThe sub-agent mapped the workspace — see its report in the card above.');
}

function subAgentScenario(done) {
  if (done.length === 0) return toolStream('', 'list_dir', { path: '.' });
  return textStream('- The workspace was listed; each top-level entry is shown in the tool output above.');
}

function defaultScenario(done, last) {
  if (done.length === 0)
    return toolStream("I'll start by looking at the workspace.\n\n1. List the files\n2. Check the Node.js version\n3. Summarize", 'list_dir', { path: '.' });
  if (done.length === 1) return toolStream('', 'run_command', { command: 'node --version' });
  const output = last.role === 'tool' ? String(last.content) : '';
  const version = /v\d+\.\d+\.\d+/.exec(output)?.[0];
  return textStream(
    `## Summary\n\n` +
      `- **Workspace** listed successfully.\n` +
      (version ? `- **Node.js** is installed: \`${version}\`.\n` : `- The command did not run (${output.split('\n')[0] || 'no output'}).\n`) +
      `- Entry point lives in \`src/extension.ts\`.\n\n` +
      '```ts\nexport function activate(context: vscode.ExtensionContext) {\n  // registers the chat view\n}\n```\n\n' +
      '| Step | Result |\n| --- | --- |\n| list_dir | done |\n| run_command | ' + (version ? 'done' : 'skipped') + ' |\n',
  );
}

function respond(messages) {
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user' && typeof m.content === 'string');
  const request = String(messages[lastUserIndex]?.content ?? '').toLowerCase();
  // Tool calls already made for this request (image follow-up messages are ignored).
  const done = messages.slice(lastUserIndex + 1).filter((m) => m.role === 'assistant' && m.tool_calls);
  const system = String(messages.find((m) => m.role === 'system')?.content ?? '');

  if (system.includes('research sub-agent')) return subAgentScenario(done);
  if (/\b(page|html|website|landing)\b/.test(request)) return pageScenario(messages, done);
  if (/\b(research|sub-?agent)\b/.test(request)) return researchScenario(done);
  return defaultScenario(done, messages.at(-1));
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('{"error":{"message":"not found"}}');
    return;
  }
  let body = '';
  for await (const part of req) body += part;
  const { messages } = JSON.parse(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const piece of respond(messages)) {
    res.write(piece);
    await new Promise((r) => setTimeout(r, 20));
  }
  res.end('data: [DONE]\n\n');
}).listen(PORT, '127.0.0.1', () => console.log(`Mock LLM listening on http://127.0.0.1:${PORT}/v1`));
