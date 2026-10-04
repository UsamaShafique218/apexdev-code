import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { PermissionDecision, PermissionMode, PermissionPolicy, PermissionRequest } from '../agent/permissions';
import { createTaskTool } from '../agent/subagent';
import { buildSystemPrompt, environmentSection } from '../agent/systemPrompt';
import { ChatStore, TranscriptEvent, chatTitle } from '../history/store';
import { VsCodeBridge } from '../ide/vscodeBridge';
import { OpenAICompatibleProvider } from '../llm/openai';
import { LLMError } from '../llm/types';
import type { MemoryStore } from '../memory/store';
import { createTools } from '../tools';
import { createMemoryTool } from '../tools/memory';
import { BackgroundProcesses, ShellInfo, ShellPreference, detectShell } from '../tools/shell';
import { Tool, ToolContext, resolvePath } from '../tools/types';
import { listModels } from '../llm/models';
import { VoiceRecorder, MAX_RECORDING_MS } from '../voice/recorder';
import { transcribe } from '../voice/transcribe';
import { expandMentions } from './mentions';
import { getWebviewHtml } from './webviewHtml';

export const API_KEY_SECRET = 'apexdev.apiKey';

type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: string[] }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'openChat'; id: string }
  | { type: 'setMode'; mode: PermissionMode }
  | { type: 'permissionResponse'; id: string; decision: PermissionDecision }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openLink'; url: string }
  | { type: 'command'; command: 'connect' | 'setApiKey' | 'openSettings' | 'history' | 'memory' }
  | { type: 'listFiles' }
  | { type: 'listModels' }
  | { type: 'setModel'; model: string }
  | { type: 'pickImages' }
  | { type: 'voiceStart' }
  | { type: 'voiceStop' }
  | { type: 'voiceCancel' };

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const FILE_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**,**/*.vsix}';
const RECENT_MODELS_KEY = 'apexdev.recentModels';

export interface ChatServices {
  background: BackgroundProcesses;
  memory: MemoryStore;
  chats: ChatStore;
  voice: VoiceRecorder;
  /** Optional tool groups (browser, desktop) that are currently switched on. */
  extraTools: () => Tool[];
  capabilities: () => { browser: boolean; desktop: boolean };
}

interface OpenChat {
  id: string;
  title: string;
  created: string;
  transcript: TranscriptEvent[];
}

const config = () => vscode.workspace.getConfiguration('apexdev');

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly permissions = new PermissionPolicy(() => config().get<PermissionMode>('permissionMode', 'ask'));
  private readonly agent: Agent;
  private readonly ide = new VsCodeBridge();
  private readonly memoryTool: Tool;
  private readonly taskTool: Tool;
  private abort?: AbortController;
  private busy = false;
  private apiKey: string | undefined;
  private shell: ShellInfo;
  private shellPreference: ShellPreference;
  private chat?: OpenChat;
  private readonly pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  private permissionSeq = 0;
  private modelCache?: { baseUrl: string; models: string[] };
  private voiceTimer?: NodeJS.Timeout;
  private voiceAbort?: AbortController;
  private voiceSeq = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: ChatServices,
  ) {
    this.shellPreference = config().get<ShellPreference>('shell', 'auto');
    this.shell = detectShell(this.shellPreference);

    this.memoryTool = createMemoryTool(services.memory, () => this.workspaceFolder());
    this.taskTool = createTaskTool({
      provider: () => this.provider(),
      // Sub-agents research code; browser and desktop stay with the main agent, which owns that state.
      tools: () => createTools(),
      toolContext: () => this.toolContext(),
      environment: () => environmentSection(this.environment()),
      maxIterations: config().get<number>('subAgents.maxIterations', 30),
    });

    this.agent = new Agent({
      tools: () => this.tools(),
      permissions: this.permissions,
      provider: () => this.provider(),
      systemPrompt: () => this.systemPrompt(),
      toolContext: () => this.toolContext(),
      requestPermission: (request) => this.requestPermission(request),
      maxIterations: () => config().get<number>('maxIterations', 60),
      contextCharBudget: () => config().get<number>('contextCharBudget', 400_000),
      vision: () => config().get<boolean>('vision', true),
    });

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('apexdev')) return;
        const preference = config().get<ShellPreference>('shell', 'auto');
        if (preference !== this.shellPreference) {
          this.shellPreference = preference;
          this.shell = detectShell(preference);
        }
        void this.postConfig();
      }),
      context.secrets.onDidChange((e) => {
        if (e.key !== API_KEY_SECRET) return;
        this.modelCache = undefined;
        void this.postConfig();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = getWebviewHtml(view.webview, this.context.extensionUri);
    view.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg), undefined, this.disposables);
    view.onDidDispose(() => {
      this.view = undefined;
      this.stop();
    });
  }

  newChat(): void {
    this.stop();
    this.agent.reset();
    this.chat = undefined;
    this.post({ type: 'cleared' });
    void this.postRecent();
  }

  async openChat(id: string): Promise<void> {
    if (this.busy) {
      void vscode.window.showWarningMessage('ApexDev: stop the current task before opening another chat.');
      return;
    }
    const record = await this.services.chats.load(id);
    if (!record) {
      void vscode.window.showWarningMessage('ApexDev: that chat could not be loaded.');
      return;
    }
    this.stop();
    this.agent.load(record.messages);
    this.chat = { id: record.id, title: record.title, created: record.created, transcript: record.transcript.slice() };
    await vscode.commands.executeCommand('apexdev.chat.focus');
    this.post({ type: 'restore', title: record.title, events: record.transcript });
  }

  async showHistory(): Promise<void> {
    type Item = vscode.QuickPickItem & { id: string };
    const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete chat' };
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'ApexDev: Chat History';
    pick.placeholder = 'Search saved chats';
    pick.matchOnDescription = true;
    const load = async () => {
      const chats = await this.services.chats.list();
      const current = this.workspaceFolder();
      pick.items = chats.map((c) => ({
        id: c.id,
        label: c.title,
        description: `${relativeTime(c.updated)}${c.workspace && c.workspace !== current ? ` · ${path.basename(c.workspace)}` : ''}`,
        buttons: [deleteButton],
      }));
      if (!chats.length) pick.placeholder = 'No saved chats yet';
    };
    pick.onDidTriggerItemButton(async (e) => {
      await this.services.chats.delete(e.item.id);
      if (this.chat?.id === e.item.id) this.chat = undefined;
      await load();
      void this.postRecent();
    });
    pick.onDidAccept(() => {
      const item = pick.selectedItems[0];
      pick.hide();
      if (item) void this.openChat(item.id);
    });
    pick.onDidHide(() => pick.dispose());
    pick.busy = true;
    pick.show();
    await load();
    pick.busy = false;
  }

  stop(): void {
    this.abort?.abort();
    for (const resolve of this.pendingPermissions.values()) resolve('deny');
    this.pendingPermissions.clear();
  }

  dispose(): void {
    this.stop();
    this.voiceCancel();
    for (const d of this.disposables) d.dispose();
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.postConfig();
        await this.postRecent();
        this.post({ type: 'busy', value: this.busy });
        if (this.chat) this.post({ type: 'restore', title: this.chat.title, events: this.chat.transcript });
        break;
      case 'send':
        await this.send(msg.text, msg.images);
        break;
      case 'listFiles':
        await this.postFiles();
        break;
      case 'listModels':
        await this.postModels();
        break;
      case 'setModel':
        await this.setModel(msg.model);
        break;
      case 'pickImages':
        await this.pickImages();
        break;
      case 'voiceStart':
        await this.voiceStart();
        break;
      case 'voiceStop':
        await this.voiceStop();
        break;
      case 'voiceCancel':
        this.voiceCancel();
        break;
      case 'stop':
        this.stop();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'openChat':
        await this.openChat(msg.id);
        break;
      case 'setMode':
        await config().update('permissionMode', msg.mode, vscode.ConfigurationTarget.Global);
        break;
      case 'permissionResponse': {
        const resolve = this.pendingPermissions.get(msg.id);
        this.pendingPermissions.delete(msg.id);
        resolve?.(msg.decision);
        break;
      }
      case 'openFile':
        await this.openFile(msg.path, msg.line);
        break;
      case 'openLink':
        if (/^https?:\/\//i.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'command': {
        const commands = {
          connect: 'apexdev.connect',
          setApiKey: 'apexdev.setApiKey',
          openSettings: 'apexdev.openSettings',
          history: 'apexdev.history',
          memory: 'apexdev.manageMemory',
        };
        await vscode.commands.executeCommand(commands[msg.command]);
        break;
      }
    }
  }

  private async send(text: string, attachedImages: string[] = []): Promise<void> {
    const images = attachedImages.filter((url) => typeof url === 'string' && url.startsWith('data:image/')).slice(0, MAX_IMAGES);
    const prompt = text.trim() || (images.length ? 'See the attached image(s).' : '');
    if (!prompt || this.busy) return;

    this.apiKey = await this.context.secrets.get(API_KEY_SECRET);
    const baseUrl = config().get<string>('baseUrl', '');
    if (!this.apiKey && !isLocalUrl(baseUrl)) {
      this.post({ type: 'error', message: 'Add an API key to start. It is stored in VS Code’s encrypted secret storage.', action: 'setApiKey' });
      return;
    }

    this.busy = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.chat ??= {
      id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      title: chatTitle(prompt),
      created: new Date().toISOString(),
      transcript: [],
    };
    this.record({ type: 'user', text: prompt, imageCount: images.length || undefined });
    this.post({ type: 'busy', value: true });

    try {
      const expanded = await expandMentions(prompt, this.cwd()).catch(() => ({ text: prompt, attached: [] as string[] }));
      if (expanded.attached.length) {
        this.emit({ type: 'notice', level: 'info', message: `Attached ${expanded.attached.join(', ')}` });
      }
      const outcome = await this.agent.run(
        expanded.text,
        {
          onTurnStart: () => this.emit({ type: 'turnStart' }),
          onText: (delta) => this.emit({ type: 'text', delta }),
          onToolStart: (e) => this.emit({ type: 'toolStart', ...e, input: previewInput(e.input) }),
          onToolProgress: (id, message) => this.post({ type: 'toolProgress', id, message }),
          onToolEnd: (e) => {
            const images = e.images?.map((i) => `data:${i.mime};base64,${i.data}`);
            this.emit({ type: 'toolEnd', id: e.id, output: e.output, isError: e.isError, denied: e.denied, images });
          },
          onRetry: (attempt, delayMs, error) =>
            this.post({ type: 'notice', level: 'warning', message: `${error.message} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/3)` }),
        },
        signal,
        images,
      );
      if (outcome === 'cancelled') this.emit({ type: 'notice', level: 'info', message: 'Stopped.' });
      if (outcome === 'max_iterations') {
        this.emit({
          type: 'notice',
          level: 'warning',
          message: 'Reached the step limit for one request. Send “continue” to keep going, or raise apexdev.maxIterations.',
        });
      }
    } catch (err) {
      const status = err instanceof LLMError ? err.status : undefined;
      const message = (err as Error).message ?? String(err);
      // Gemini answers a bad key with 400, so look at the message as well as the status.
      const badKey = status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(message));
      const action = badKey ? 'setApiKey' : status === 404 || status === 400 ? 'connect' : undefined;
      this.emit({ type: 'error', message, action });
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.post({ type: 'busy', value: false });
      await this.saveChat();
    }
  }

  /** Posts a UI event and keeps it in the chat transcript so the chat can be redrawn later. */
  private emit(event: TranscriptEvent): void {
    this.record(event);
    this.post(event);
  }

  private record(event: TranscriptEvent): void {
    const transcript = this.chat?.transcript;
    if (!transcript) return;
    const last = transcript[transcript.length - 1];
    if (event.type === 'text' && last?.type === 'text') {
      last.delta = `${last.delta}${event.delta}`;
      return;
    }
    transcript.push({ ...event });
  }

  private async saveChat(): Promise<void> {
    const chat = this.chat;
    if (!chat || !this.agent.messages.length || !config().get<boolean>('history.enabled', true)) return;
    try {
      await this.services.chats.save({
        ...chat,
        updated: new Date().toISOString(),
        workspace: this.workspaceFolder(),
        messages: [...this.agent.messages],
      });
    } catch (err) {
      console.error('ApexDev: could not save chat', err);
    }
  }

  private requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const id = `perm-${++this.permissionSeq}`;
    this.view?.show?.(true);
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, resolve);
      this.post({
        type: 'permission',
        id,
        name: request.tool.name,
        label: request.tool.label,
        kind: request.tool.kind,
        summary: request.summary,
        detail: permissionDetail(request),
        dangerous: request.dangerous,
      });
    });
  }

  private tools(): Tool[] {
    const extra = [...this.services.extraTools()];
    if (config().get<boolean>('memory.enabled', true)) extra.push(this.memoryTool);
    if (config().get<boolean>('subAgents.enabled', true)) extra.push(this.taskTool);
    return createTools(extra);
  }

  private provider(): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      baseUrl: config().get('baseUrl', 'https://api.openai.com/v1'),
      model: config().get('model', 'gpt-4o'),
      apiKey: this.apiKey,
      maxTokens: config().get<number>('maxTokens', 0) || undefined,
      temperature: config().get<number | null>('temperature', null),
    });
  }

  private toolContext(): Omit<ToolContext, 'signal' | 'readFiles' | 'progress'> {
    return { cwd: this.cwd(), shell: this.shell, background: this.services.background, ide: this.ide };
  }

  private workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private cwd(): string {
    return this.workspaceFolder() ?? os.homedir();
  }

  private environment() {
    return {
      cwd: this.cwd(),
      hasWorkspace: Boolean(this.workspaceFolder()),
      shellName: this.shell.name,
      model: config().get('model', 'gpt-4o'),
    };
  }

  private async systemPrompt(): Promise<string> {
    const env = this.environment();
    const memoryOn = config().get<boolean>('memory.enabled', true);
    const [projectInstructions, memories] = await Promise.all([
      fs.readFile(path.join(env.cwd, 'APEXDEV.md'), 'utf8').catch(() => undefined),
      memoryOn ? this.services.memory.promptSection(this.workspaceFolder()) : Promise.resolve(''),
    ]);
    const caps = this.services.capabilities();
    return buildSystemPrompt({
      ...env,
      projectInstructions,
      memories,
      capabilities: {
        browser: caps.browser,
        desktop: caps.desktop,
        memory: memoryOn,
        subAgents: config().get<boolean>('subAgents.enabled', true),
      },
    });
  }

  private async postConfig(): Promise<void> {
    const baseUrl = config().get<string>('baseUrl', '');
    const hasKey = Boolean(await this.context.secrets.get(API_KEY_SECRET));
    this.post({
      type: 'config',
      model: config().get('model', 'gpt-4o'),
      host: hostOf(baseUrl),
      mode: config().get('permissionMode', 'ask'),
      needsKey: !hasKey && !isLocalUrl(baseUrl),
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? null,
    });
  }

  private async postRecent(): Promise<void> {
    const chats = await this.services.chats.list(this.workspaceFolder()).catch(() => []);
    this.post({
      type: 'recent',
      chats: chats.slice(0, 5).map((c) => ({ id: c.id, title: c.title, when: relativeTime(c.updated) })),
    });
  }

  /** Workspace files and folders for @ mentions; open editors are listed first by the panel. */
  private async postFiles(): Promise<void> {
    const root = this.workspaceFolder();
    if (!root) {
      this.post({ type: 'files', files: [], folders: [], open: [] });
      return;
    }
    const rel = (fsPath: string) => path.relative(root, fsPath).split(path.sep).join('/');
    const uris = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE, 5000);
    const files = uris.map((u) => rel(u.fsPath)).sort();
    const folders = new Set<string>();
    for (const file of files) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) folders.add(`${parts.slice(0, i).join('/')}/`);
    }
    const open = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri)
      .filter((u): u is vscode.Uri => u?.scheme === 'file' && u.fsPath.startsWith(root))
      .map((u) => rel(u.fsPath));
    this.post({ type: 'files', files, folders: [...folders].sort(), open: [...new Set(open)] });
  }

  private async postModels(): Promise<void> {
    const baseUrl = config().get<string>('baseUrl', '');
    let models = this.modelCache?.baseUrl === baseUrl ? this.modelCache.models : undefined;
    let error: string | undefined;
    if (!models) {
      try {
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
        models = await listModels(baseUrl, apiKey, AbortSignal.timeout(15_000));
        this.modelCache = { baseUrl, models };
      } catch (err) {
        error = `Could not list models (${(err as Error).message}). Type a model ID to use it.`;
        models = [];
      }
    }
    this.post({
      type: 'models',
      models,
      recent: this.context.globalState.get<string[]>(RECENT_MODELS_KEY, []),
      current: config().get('model', 'gpt-4o'),
      host: hostOf(baseUrl),
      error,
    });
  }

  private async setModel(model: string): Promise<void> {
    const id = model.trim();
    if (!id) return;
    // A workspace value would shadow a global one, so update wherever the model is set now.
    const target = config().inspect<string>('model')?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const previous = config().get<string>('model', '').trim();
    await config().update('model', id, target);
    // Keep the model being replaced too, so switching back is one click.
    const recent = [id, previous, ...this.context.globalState.get<string[]>(RECENT_MODELS_KEY, [])].filter(Boolean);
    await this.context.globalState.update(RECENT_MODELS_KEY, [...new Set(recent)].slice(0, 5));
  }

  private async pickImages(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: 'Attach images',
      canSelectMany: true,
      filters: { Images: Object.keys(IMAGE_TYPES) },
    });
    if (!uris?.length) return;
    const images: Array<{ name: string; url: string }> = [];
    for (const uri of uris.slice(0, MAX_IMAGES)) {
      const mime = IMAGE_TYPES[path.extname(uri.fsPath).slice(1).toLowerCase()];
      if (!mime) continue;
      const data = await fs.readFile(uri.fsPath);
      if (data.length > MAX_IMAGE_BYTES) {
        void vscode.window.showWarningMessage(`ApexDev: ${path.basename(uri.fsPath)} is larger than 8 MB and was skipped.`);
        continue;
      }
      images.push({ name: path.basename(uri.fsPath), url: `data:${mime};base64,${data.toString('base64')}` });
    }
    this.post({ type: 'images', images });
  }

  private async voiceStart(): Promise<void> {
    if (this.services.voice.recording) return;
    const seq = ++this.voiceSeq;
    try {
      await this.services.voice.start();
      if (seq !== this.voiceSeq) return this.services.voice.cancel(); // cancelled while the mic was starting
      this.post({ type: 'voice', state: 'recording', maxMs: MAX_RECORDING_MS });
      this.voiceTimer = setTimeout(() => void this.voiceStop(), MAX_RECORDING_MS);
    } catch (err) {
      if (seq === this.voiceSeq) this.post({ type: 'voice', state: 'idle', error: (err as Error).message });
    }
  }

  private async voiceStop(): Promise<void> {
    clearTimeout(this.voiceTimer);
    if (!this.services.voice.recording) return;
    this.post({ type: 'voice', state: 'transcribing' });
    this.voiceAbort = new AbortController();
    try {
      const audio = await this.services.voice.stop();
      // 16 kHz × 16-bit mono = 32 000 bytes per second.
      if (audio.length < 44 + 16_000) throw new Error('The recording was too short — hold the mic for at least a second.');
      const mode = config().get<'chat' | 'whisper'>('voice.transcription', 'chat');
      const text = await transcribe(audio, {
        baseUrl: config().get('baseUrl', 'https://api.openai.com/v1'),
        apiKey: await this.context.secrets.get(API_KEY_SECRET),
        model: config().get<string>('voice.model', '') || (mode === 'whisper' ? 'whisper-1' : config().get('model', 'gpt-4o')),
        mode,
        signal: this.voiceAbort.signal,
      });
      this.post({
        type: 'voice',
        state: 'idle',
        text,
        error: text ? undefined : 'No speech was recognised. Try again a little closer to the microphone.',
      });
    } catch (err) {
      const cancelled = this.voiceAbort?.signal.aborted;
      this.post({ type: 'voice', state: 'idle', error: cancelled ? undefined : (err as Error).message });
    } finally {
      this.voiceAbort = undefined;
    }
  }

  private voiceCancel(): void {
    this.voiceSeq++;
    clearTimeout(this.voiceTimer);
    this.voiceAbort?.abort();
    this.services.voice.cancel();
    this.post({ type: 'voice', state: 'idle' });
  }

  private async openFile(file: string, line?: number): Promise<void> {
    try {
      const uri = vscode.Uri.file(resolvePath(this.cwd(), file));
      const doc = await vscode.workspace.openTextDocument(uri);
      const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: true });
    } catch {
      void vscode.window.showWarningMessage(`ApexDev: could not open ${file}`);
    }
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Keeps large tool inputs (whole file contents) from flooding the webview. */
function previewInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = typeof value === 'string' && value.length > 4000 ? `${value.slice(0, 4000)}\n… (${value.length} chars)` : value;
  }
  return out;
}

function permissionDetail(request: PermissionRequest): string {
  const input = request.input ?? {};
  const clip = (text: string, lines = 30) => {
    const all = String(text).split('\n');
    return all.length > lines ? `${all.slice(0, lines).join('\n')}\n… (${all.length - lines} more lines)` : String(text);
  };
  switch (request.tool.name) {
    case 'run_command':
      return input.command ?? '';
    case 'write_file':
      return clip(input.content ?? '');
    case 'edit_file':
      return `${clip(input.old_string ?? '', 15).replace(/^/gm, '- ')}\n${clip(input.new_string ?? '', 15).replace(/^/gm, '+ ')}`;
    case 'vscode_command':
      return `${input.command ?? ''}${input.args ? `\n${JSON.stringify(input.args, null, 2)}` : ''}`;
    default:
      return JSON.stringify(input, null, 2);
  }
}
