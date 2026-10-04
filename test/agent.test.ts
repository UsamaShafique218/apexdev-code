import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Agent, compactHistory, pruneImages, ToolEndEvent, ToolStartEvent } from '../src/agent/agent';
import { PermissionDecision, PermissionMode, PermissionPolicy } from '../src/agent/permissions';
import { createTaskTool } from '../src/agent/subagent';
import { OpenAICompatibleProvider, retryAfter } from '../src/llm/openai';
import { ChatMessage } from '../src/llm/types';
import { createTools } from '../src/tools';
import { BackgroundProcesses, detectShell } from '../src/tools/shell';
import { Tool } from '../src/tools/types';

/** Scripted OpenAI-compatible server: each request pops the next scripted response. */
let server: Server;
let baseUrl: string;
let script: Array<(body: any) => string[] | { status: number; body: string }> = [];
const requests: any[] = [];

const sse = (chunks: object[]) => [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
const textChunks = (text: string) =>
  sse([...text.match(/.{1,5}/gs)!.map((t) => ({ choices: [{ delta: { content: t } }] })), { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
const toolChunks = (id: string, name: string, args: object) => {
  const json = JSON.stringify(args);
  const half = Math.floor(json.length / 2);
  return sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(0, half) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(half) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
};

/** Several tool calls in one response, as models do for parallel calls. */
const multiToolChunks = (calls: Array<[id: string, name: string, args: object]>) =>
  sse([
    ...calls.map(([id, name, args], index) => ({
      choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    })),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);

/** A read-only test tool that takes `ms` to finish and records when it ran. */
function slowTool(name: string, ms: number, log: Array<[string, 'start' | 'end']>, kind: Tool['kind'] = 'read'): Tool {
  return {
    name,
    label: name,
    kind,
    description: 'test tool',
    parameters: { type: 'object', properties: {} },
    summarize: () => '',
    async execute() {
      log.push([name, 'start']);
      await new Promise((r) => setTimeout(r, ms));
      log.push([name, 'end']);
      return `${name} done`;
    },
  };
}

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function readBody(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return JSON.parse(data);
}

before(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ body, auth: req.headers.authorization });
    const next = script.shift();
    const result = next ? next(body) : textChunks('no script');
    if (!Array.isArray(result)) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Split writes mid-line to exercise the SSE buffer.
    const payload = result.join('');
    const third = Math.floor(payload.length / 3);
    res.write(payload.slice(0, third));
    setTimeout(() => {
      res.write(payload.slice(third, third * 2));
      res.end(payload.slice(third * 2));
    }, 5);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => server.close());

const provider = () => new OpenAICompatibleProvider({ baseUrl, model: 'test-model', apiKey: 'sk-test' });
const toolContext = () => ({ cwd: process.cwd(), shell: detectShell(), background: new BackgroundProcesses() });

function makeAgent(opts: { mode?: PermissionMode; decision?: PermissionDecision; extra?: Tool[]; vision?: boolean } = {}) {
  const permissionRequests: string[] = [];
  const agent = new Agent({
    provider,
    tools: () => createTools(opts.extra),
    systemPrompt: () => 'system prompt',
    toolContext,
    permissions: new PermissionPolicy(() => opts.mode ?? 'ask'),
    requestPermission: async (r) => {
      permissionRequests.push(r.summary);
      return opts.decision ?? 'once';
    },
    maxIterations: () => 5,
    contextCharBudget: () => 400_000,
    vision: () => opts.vision ?? true,
  });
  const events = { text: '', starts: [] as ToolStartEvent[], ends: [] as ToolEndEvent[], progress: [] as string[] };
  const handlers = {
    onText: (d: string) => (events.text += d),
    onToolStart: (e: ToolStartEvent) => events.starts.push(e),
    onToolEnd: (e: ToolEndEvent) => events.ends.push(e),
    onToolProgress: (_id: string, m: string) => events.progress.push(m),
  };
  return { agent, events, handlers, permissionRequests };
}

describe('agent loop', () => {
  it('streams text, runs a tool and feeds the result back', async () => {
    requests.length = 0;
    script = [() => toolChunks('call_1', 'list_dir', { path: 'src' }), () => textChunks('The src folder has agent, llm, tools and ui.')];
    const { agent, events, handlers } = makeAgent();
    const outcome = await agent.run('What is in src?', handlers, new AbortController().signal);

    assert.equal(outcome, 'completed');
    assert.equal(events.text, 'The src folder has agent, llm, tools and ui.');
    assert.equal(events.starts[0].name, 'list_dir');
    assert.equal(events.starts[0].summary, 'src');
    assert.match(events.ends[0].output, /agent\//);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].auth, 'Bearer sk-test');
    assert.equal(requests[0].body.model, 'test-model');
    assert.equal(requests[0].body.messages[0].role, 'system');
    assert.equal(requests[0].body.tools.length, createTools().length);
    const second: ChatMessage[] = requests[1].body.messages;
    assert.equal(second.at(-2)!.role, 'assistant');
    assert.equal(second.at(-1)!.role, 'tool');
    assert.equal((second.at(-1) as any).tool_call_id, 'call_1');
    assert.equal(agent.messages.length, 4);
  });

  it('asks before running commands and reports denials to the model', async () => {
    script = [() => toolChunks('call_2', 'run_command', { command: 'node --version' }), () => textChunks('Okay, I will not run it.')];
    const { agent, events, handlers, permissionRequests } = makeAgent({ decision: 'deny' });
    await agent.run('Check node version', handlers, new AbortController().signal);
    assert.deepEqual(permissionRequests, ['node --version']);
    assert.equal(events.ends[0].denied, true);
    assert.match(events.ends[0].output, /denied/);
  });

  it('runs commands without asking in fullAuto mode', async () => {
    script = [() => toolChunks('call_3', 'run_command', { command: 'node --version' }), () => textChunks('Node is installed.')];
    const { agent, events, handlers, permissionRequests } = makeAgent({ mode: 'fullAuto' });
    await agent.run('Check node version', handlers, new AbortController().signal);
    assert.equal(permissionRequests.length, 0);
    assert.match(events.ends[0].output, /v\d+\.\d+/);
  });

  it('still asks for destructive commands in fullAuto mode', async () => {
    script = [() => toolChunks('call_4', 'run_command', { command: 'rm -rf ./build' }), () => textChunks('Skipped.')];
    const { agent, handlers, permissionRequests } = makeAgent({ mode: 'fullAuto', decision: 'deny' });
    await agent.run('Clean build', handlers, new AbortController().signal);
    assert.deepEqual(permissionRequests, ['rm -rf ./build']);
  });

  it('returns tool errors to the model instead of crashing', async () => {
    script = [() => toolChunks('call_5', 'read_file', { path: 'does/not/exist.ts' }), () => textChunks('That file does not exist.')];
    const { agent, events, handlers } = makeAgent();
    const outcome = await agent.run('Read it', handlers, new AbortController().signal);
    assert.equal(outcome, 'completed');
    assert.equal(events.ends[0].isError, true);
    assert.match(events.ends[0].output, /^Error: File not found/);
  });

  it('retries on 5xx and surfaces 4xx errors', async () => {
    script = [() => ({ status: 503, body: '{"error":{"message":"overloaded"}}' }), () => textChunks('Recovered.')];
    const { agent, events, handlers } = makeAgent();
    await agent.run('hi', { ...handlers, onRetry: () => undefined }, new AbortController().signal);
    assert.equal(events.text, 'Recovered.');

    script = [() => ({ status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' })];
    await assert.rejects(makeAgent().agent.run('hi', handlers, new AbortController().signal), /401.*Incorrect API key/);
  });

  it('waits as long as a rate-limited server asks before retrying', async () => {
    assert.equal(retryAfter('7', ''), 7000);
    assert.equal(retryAfter(null, '[{"error":{"details":[{"retryDelay":"37s"}]}}]'), 37000);
    assert.equal(retryAfter(null, 'Rate limit reached. Please try again in 1.5s.'), 1500);
    assert.equal(retryAfter(null, 'no hint'), undefined);

    script = [() => ({ status: 429, body: '{"error":{"message":"Please try again in 1.2s"}}' }), () => textChunks('Back.')];
    const delays: number[] = [];
    const { agent, events, handlers } = makeAgent();
    await agent.run('hi', { ...handlers, onRetry: (_a, ms) => delays.push(ms) }, new AbortController().signal);
    assert.deepEqual(delays, [1200]);
    assert.equal(events.text, 'Back.');
  });

  it('gives up at once when the quota is used up for hours', async () => {
    assert.equal(retryAfter(null, 'Quota exceeded. Please retry in 16h9m58.2s.'), 58198200);
    script = [() => ({ status: 429, body: '{"error":{"message":"Quota exceeded. Please retry in 16h9m58.2s."}}' }), () => textChunks('Back.')];
    const delays: number[] = [];
    const { agent, handlers } = makeAgent();
    await assert.rejects(agent.run('hi', { ...handlers, onRetry: (_a, ms) => delays.push(ms) }, new AbortController().signal), /429.*Quota exceeded/);
    assert.deepEqual(delays, []);
  });

  it('keeps parallel calls apart when a gateway gives them all index 0', async () => {
    script = [
      () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"src"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'g2', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.json"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      () => textChunks('Listed.'),
    ];
    const { agent, events, handlers } = makeAgent();
    await agent.run('look', handlers, new AbortController().signal);
    assert.deepEqual(events.starts.map((s) => s.name), ['list_dir', 'glob']);
  });

  it("sends Gemini's thought_signature back with the tool call", async () => {
    requests.length = 0;
    const extra_content = { google: { thought_signature: 'sig-123' } };
    script = [
      () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"src"}' }, extra_content }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      () => textChunks('Listed.'),
    ];
    const { agent, handlers } = makeAgent();
    await agent.run('look', handlers, new AbortController().signal);
    const assistant = requests[1].body.messages.find((m: any) => m.role === 'assistant');
    assert.deepEqual(assistant.tool_calls[0].extra_content, extra_content);
  });

  it('sends images the user attached after their message', async () => {
    requests.length = 0;
    script = [() => textChunks('A login form.')];
    const { agent, handlers } = makeAgent();
    const url = 'data:image/png;base64,iVBORw0KGgo=';
    await agent.run('What is this?', handlers, new AbortController().signal, [url]);
    const users = requests[0].body.messages.filter((m: any) => m.role === 'user');
    assert.equal(users[0].content, 'What is this?');
    assert.deepEqual(users[1].content[1], { type: 'image_url', image_url: { url } });
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent, handlers } = makeAgent();
    assert.equal(await agent.run('hi', handlers, controller.signal), 'cancelled');
  });

  it('runs consecutive read-only calls in parallel and keeps result order', async () => {
    const log: Array<[string, 'start' | 'end']> = [];
    const extra = [slowTool('slow_a', 120, log), slowTool('slow_b', 40, log), slowTool('act_c', 10, log, 'execute')];
    requests.length = 0;
    script = [
      () => multiToolChunks([['a', 'slow_a', {}], ['b', 'slow_b', {}], ['c', 'act_c', {}]]),
      () => textChunks('All done.'),
    ];
    const { agent, handlers } = makeAgent({ extra, mode: 'fullAuto' });
    assert.equal(await agent.run('go', handlers, new AbortController().signal), 'completed');

    // both reads start before either ends; the execute tool waits for the read group
    assert.deepEqual(log.slice(0, 2).map((l) => l.join(':')).sort(), ['slow_a:start', 'slow_b:start']);
    assert.deepEqual(log.slice(-2), [['act_c', 'start'], ['act_c', 'end']]);
    const toolMessages = requests[1].body.messages.filter((m: any) => m.role === 'tool');
    assert.deepEqual(toolMessages.map((m: any) => m.tool_call_id), ['a', 'b', 'c']);
    assert.deepEqual(toolMessages.map((m: any) => m.content), ['slow_a done', 'slow_b done', 'act_c done']);
  });

  it('sends tool screenshots to the model as an image message (unless vision is off)', async () => {
    const shot: Tool = {
      name: 'shot',
      label: 'Shot',
      kind: 'read',
      description: 'screenshot',
      parameters: { type: 'object', properties: {} },
      summarize: () => '',
      execute: async () => ({ text: 'Captured 1×1', images: [{ mime: 'image/png', data: PIXEL }] }),
    };
    for (const vision of [true, false]) {
      requests.length = 0;
      script = [() => toolChunks('s1', 'shot', {}), () => textChunks('A single pixel.')];
      const { agent, events, handlers } = makeAgent({ extra: [shot], vision });
      await agent.run('look', handlers, new AbortController().signal);
      assert.equal(events.ends[0].images?.length, 1);
      const last = requests[1].body.messages.at(-1);
      if (vision) {
        assert.equal(last.role, 'user');
        assert.equal(last.content[1].type, 'image_url');
        assert.equal(last.content[1].image_url.url, `data:image/png;base64,${PIXEL}`);
      } else {
        assert.equal(last.role, 'tool');
      }
    }
  });

  it('reports tool progress and can continue a loaded history', async () => {
    const reporter: Tool = {
      name: 'reporter',
      label: 'Reporter',
      kind: 'read',
      description: 'progress',
      parameters: { type: 'object', properties: {} },
      summarize: () => '',
      async execute(_i, ctx) {
        ctx.progress?.('halfway');
        return 'ok';
      },
    };
    script = [() => toolChunks('r1', 'reporter', {}), () => textChunks('Done.')];
    const { agent, events, handlers } = makeAgent({ extra: [reporter] });
    agent.load([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
    requests.length = 0;
    await agent.run('now', handlers, new AbortController().signal);
    assert.deepEqual(events.progress, ['halfway']);
    assert.deepEqual(requests[0].body.messages.slice(1, 3).map((m: any) => m.content), ['earlier question', 'earlier answer']);
  });
});

describe('task sub-agent', () => {
  it('runs a child agent with read-only tools and returns its final report', async () => {
    requests.length = 0;
    script = [
      () => toolChunks('sub1', 'glob', { pattern: 'src/agent/*.ts' }),
      () => textChunks('Found agent.ts, permissions.ts, subagent.ts and systemPrompt.ts in src/agent.'),
    ];
    const task = createTaskTool({ provider, tools: () => createTools(), toolContext, environment: () => '# Environment\n- test' });
    const progress: string[] = [];
    const result = await task.execute(
      { description: 'List agent files', prompt: 'Which files are in src/agent?' },
      { ...toolContext(), signal: new AbortController().signal, readFiles: new Set(), progress: (m) => progress.push(m) },
    );
    assert.match(String(result), /subagent\.ts/);
    assert.match(String(result), /used 1 tool call/);
    assert.deepEqual(progress, ['1 step · Find src/agent/*.ts']);

    const toolNames: string[] = requests[0].body.tools.map((t: any) => t.function.name);
    assert.ok(toolNames.includes('read_file') && toolNames.includes('grep'));
    for (const forbidden of ['write_file', 'edit_file', 'run_command', 'task', 'todo_write', 'memory']) {
      assert.ok(!toolNames.includes(forbidden), `${forbidden} must not be offered to sub-agents`);
    }
    assert.match(requests[0].body.messages[0].content, /research sub-agent/);
  });
});

describe('pruneImages', () => {
  it('keeps only the newest images', () => {
    const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } };
    const history: ChatMessage[] = [1, 2, 3].map(() => ({ role: 'user' as const, content: [{ type: 'text' as const, text: 'shots' }, image, image] }));
    pruneImages(history, 3);
    const kept = history.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url');
    assert.equal(kept.length, 3);
    assert.equal((history[0].content as any[]).filter((p) => p.type === 'image_url').length, 0);
    assert.equal((history[2].content as any[]).filter((p) => p.type === 'image_url').length, 2);
  });
});

describe('compactHistory', () => {
  it('trims old tool output first, then drops whole old exchanges', () => {
    const big = 'x'.repeat(5000);
    const history: ChatMessage[] = [];
    for (let i = 0; i < 4; i++) {
      history.push({ role: 'user', content: `q${i}` });
      history.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      history.push({ role: 'tool', tool_call_id: `c${i}`, content: big });
      history.push({ role: 'assistant', content: `a${i}` });
    }
    compactHistory(history, 12_000);
    assert.equal(history[0].role, 'user');
    assert.ok(history.filter((m) => m.role === 'tool').some((m) => m.content.includes('trimmed')));

    compactHistory(history, 3_000);
    assert.equal(history[0].role, 'user');
    // tool messages are never orphaned from their assistant call
    history.forEach((m, i) => {
      if (m.role === 'tool') assert.equal(history[i - 1].role, 'assistant');
    });
  });
});
