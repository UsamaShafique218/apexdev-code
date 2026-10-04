// End-to-end: the real agent loop and OpenAI-compatible client talk to scripts/mock-llm.mjs over HTTP,
// and the real file, plan, sub-agent and browser tools run against a temp workspace.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Agent, ToolEndEvent, ToolStartEvent } from '../src/agent/agent';
import { PermissionPolicy } from '../src/agent/permissions';
import { createTaskTool } from '../src/agent/subagent';
import { BrowserSession, findBrowserExecutable } from '../src/browser/session';
import { OpenAICompatibleProvider } from '../src/llm/openai';
import { createBrowserTools } from '../src/tools/browser';
import { createTools } from '../src/tools/index';
import { BackgroundProcesses, detectShell } from '../src/tools/shell';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const executable = findBrowserExecutable();

let server: ChildProcess;
let workspace: string;
let profile: string;
let browser: BrowserSession;

before(async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), 'apexdev e2e '));
  profile = mkdtempSync(path.join(os.tmpdir(), 'apexdev-e2e-profile-'));
  writeFileSync(path.join(workspace, 'README.md'), '# Demo\n');
  browser = new BrowserSession({ profileDir: profile, headless: () => true });
  server = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'mock-llm.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
  });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.once('data', () => resolve());
    server.once('exit', (code) => reject(new Error(`mock server exited with ${code}`)));
  });
});

after(async () => {
  server?.kill();
  await browser?.dispose();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function makeAgent() {
  const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${PORT}/v1`, model: 'mock' });
  const background = new BackgroundProcesses();
  const toolContext = () => ({ cwd: workspace, shell: detectShell(), background });
  const environment = `## Environment\n- Workspace root: ${workspace}`;
  const task = createTaskTool({ provider: () => provider, tools: () => createTools(), toolContext, environment: () => environment });
  const browserTools = createBrowserTools(browser);
  const events = { starts: [] as ToolStartEvent[], ends: [] as ToolEndEvent[], text: '', progress: [] as string[] };
  const agent = new Agent({
    provider: () => provider,
    tools: () => createTools([...browserTools, task]),
    systemPrompt: () => `You are ApexDev.\n\n${environment}`,
    toolContext,
    permissions: new PermissionPolicy(() => 'fullAuto'),
    requestPermission: async () => 'deny',
    maxIterations: () => 20,
    contextCharBudget: () => 200_000,
    vision: () => true,
  });
  const run = (text: string) =>
    agent.run(
      text,
      {
        onText: (d) => (events.text += d),
        onToolStart: (e) => events.starts.push(e),
        onToolEnd: (e) => events.ends.push(e),
        onToolProgress: (_id, m) => events.progress.push(m),
      },
      new AbortController().signal,
    );
  return { run, events };
}

describe('end to end with the mock model', () => {
  it('builds index.html, opens it in a real browser and screenshots it', { skip: executable ? false : 'no Chrome/Edge found', timeout: 90_000 }, async () => {
    const { run, events } = makeAgent();
    const outcome = await run('Make a simple html page');
    assert.equal(outcome, 'completed');

    const names = events.starts.map((e) => e.name);
    assert.deepEqual(names, ['todo_write', 'write_file', 'todo_write', 'browser_navigate', 'todo_write', 'browser_screenshot', 'todo_write']);
    for (const end of events.ends) assert.equal(end.isError, false, `${end.id} failed: ${end.output}`);

    const html = readFileSync(path.join(workspace, 'index.html'), 'utf8');
    assert.match(html, /<h1>Hello from ApexDev<\/h1>/);

    const nav = events.ends[names.indexOf('browser_navigate')];
    assert.match(nav.output, /Hello from ApexDev/, 'the browser rendered the generated page');

    const shot = events.ends[names.indexOf('browser_screenshot')];
    assert.equal(shot.images?.length, 1);
    assert.ok(Buffer.from(shot.images![0].data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'screenshot is a JPEG');

    assert.match(events.text, /Created `index.html`/);
  });

  it('delegates research to a sub-agent that only has read-only tools', { timeout: 30_000 }, async () => {
    const { run, events } = makeAgent();
    assert.equal(await run('Please research the project layout'), 'completed');
    assert.deepEqual(events.starts.map((e) => e.name), ['task']);
    const report = events.ends[0];
    assert.equal(report.isError, false, report.output);
    assert.match(report.output, /sub-agent used 1 tool call/);
    assert.ok(events.progress.some((p) => /List/.test(p)), `progress: ${events.progress.join(' | ')}`);
  });
});
