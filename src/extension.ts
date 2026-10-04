import * as path from 'path';
import * as vscode from 'vscode';
import { BrowserSession } from './browser/session';
import { DesktopHost } from './desktop/host';
import { ChatStore } from './history/store';
import { listModels } from './llm/models';
import { PROVIDERS, ProviderPreset, pickModel } from './llm/providers';
import { MemoryStore } from './memory/store';
import { createBrowserTools } from './tools/browser';
import { createDesktopTools } from './tools/desktop';
import { BackgroundProcesses } from './tools/shell';
import type { Tool } from './tools/types';
import { API_KEY_SECRET, ChatViewProvider } from './ui/ChatViewProvider';
import { VoiceRecorder } from './voice/recorder';

const config = () => vscode.workspace.getConfiguration('apexdev');

let cleanup: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const storage = context.globalStorageUri.fsPath;
  const background = new BackgroundProcesses();
  const memory = new MemoryStore(path.join(storage, 'memory.json'));
  const chats = new ChatStore(path.join(storage, 'chats'));

  // Browser and desktop processes start lazily on the first tool call that needs them.
  const browser = new BrowserSession({
    profileDir: path.join(storage, 'browser-profile'),
    executablePath: () => config().get<string>('browser.executablePath') || undefined,
    headless: () => config().get<boolean>('browser.headless', false),
  });
  const desktop = new DesktopHost({
    scriptPath: context.asAbsolutePath(path.join('resources', 'desktop', 'host.ps1')),
    tempDir: path.join(storage, 'desktop'),
  });
  const browserTools = createBrowserTools(browser);
  const desktopTools = createDesktopTools(desktop);

  const capabilities = () => ({
    browser: config().get<boolean>('browser.enabled', true),
    desktop: config().get<boolean>('desktop.enabled', true) && desktopTools.length > 0,
  });
  const extraTools = (): Tool[] => {
    const caps = capabilities();
    return [...(caps.browser ? browserTools : []), ...(caps.desktop ? desktopTools : [])];
  };

  const voice = new VoiceRecorder(context.asAbsolutePath(path.join('resources', 'voice', 'record.ps1')), path.join(storage, 'voice'));
  const chat = new ChatViewProvider(context, { background, memory, chats, voice, extraTools, capabilities });

  cleanup = async () => {
    background.killAll();
    voice.cancel();
    await Promise.allSettled([browser.dispose(), desktop.dispose()]);
  };

  context.subscriptions.push(
    chat,
    vscode.window.registerWebviewViewProvider('apexdev.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('apexdev.focus', () => vscode.commands.executeCommand('apexdev.chat.focus')),
    vscode.commands.registerCommand('apexdev.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('apexdev.stop', () => chat.stop()),
    vscode.commands.registerCommand('apexdev.history', () => chat.showHistory()),
    vscode.commands.registerCommand('apexdev.manageMemory', () => manageMemory(memory)),
    vscode.commands.registerCommand('apexdev.closeBrowser', () => browser.dispose()),
    vscode.commands.registerCommand('apexdev.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:apexdev.apexdev-code'),
    ),
    vscode.commands.registerCommand('apexdev.connect', () => connectProvider(context)),
    vscode.commands.registerCommand('apexdev.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'ApexDev: API Key',
        prompt: 'API key for your OpenAI-compatible provider. Stored in VS Code’s encrypted secret storage.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'Enter a key'),
      });
      if (!key) return;
      await context.secrets.store(API_KEY_SECRET, key.trim());
      void vscode.window.showInformationMessage('ApexDev: API key saved.');
    }),
    vscode.commands.registerCommand('apexdev.clearApiKey', async () => {
      await context.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage('ApexDev: API key removed.');
    }),
  );
}

export async function deactivate(): Promise<void> {
  await cleanup?.();
  cleanup = undefined;
}

/** Provider picker: sets the base URL, asks for the key and chooses a model the provider actually offers. */
async function connectProvider(context: vscode.ExtensionContext): Promise<void> {
  type Item = vscode.QuickPickItem & { preset?: ProviderPreset };
  const current = config().get<string>('baseUrl', '').replace(/\/+$/, '');
  const items: Item[] = [
    ...PROVIDERS.map((p) => ({
      label: p.label,
      description: p.baseUrl === current ? `${p.detail} · current` : p.detail,
      preset: p,
    })),
    { label: 'Other OpenAI-compatible API…', description: 'Enter the base URL and model in Settings' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'ApexDev: Connect a model',
    placeHolder: 'Choose your AI provider',
  });
  if (!picked) return;
  const preset = picked.preset;
  if (!preset) {
    await vscode.commands.executeCommand('apexdev.openSettings');
    return;
  }

  let apiKey = await context.secrets.get(API_KEY_SECRET);
  if (preset.keyUrl) {
    const entered = await askForKey(preset, Boolean(apiKey));
    if (entered === undefined) return;
    if (entered) apiKey = entered;
  }

  await config().update('baseUrl', preset.baseUrl, vscode.ConfigurationTarget.Global);
  if (preset.keyUrl && apiKey) await context.secrets.store(API_KEY_SECRET, apiKey);

  let available: string[] = [];
  let failure: string | undefined;
  try {
    available = await listModels(preset.baseUrl, preset.keyUrl ? apiKey : undefined, AbortSignal.timeout(10_000));
  } catch (err) {
    failure = (err as Error).message;
  }
  const model = pickModel(preset, available);
  if (model) await config().update('model', model, vscode.ConfigurationTarget.Global);

  if (failure) {
    const hint = preset.keyUrl ? 'Check the API key' : `Make sure ${preset.label} is running`;
    void vscode.window.showWarningMessage(`ApexDev: switched to ${preset.label}, but its model list could not be loaded (${failure}). ${hint}.`);
  } else {
    void vscode.window.showInformationMessage(`ApexDev: connected to ${preset.label}${model ? ` · ${model}` : ''}.`);
  }
}

/** Resolves to the trimmed key, '' to keep the saved one, or undefined when cancelled. */
function askForKey(preset: ProviderPreset, hasKey: boolean): Promise<string | undefined> {
  const input = vscode.window.createInputBox();
  const getKey: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: `Get a ${preset.label} key` };
  input.title = `ApexDev: ${preset.label} API key`;
  input.prompt = `Paste your ${preset.label} API key — no key yet? Use the ↗ button above to create one. Stored in VS Code’s encrypted secret storage.`;
  input.placeholder = hasKey ? 'Leave empty to keep the saved key' : 'API key';
  input.password = true;
  input.ignoreFocusOut = true;
  input.buttons = [getKey];
  return new Promise((resolve) => {
    let done = false;
    input.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(preset.keyUrl!)));
    input.onDidChangeValue(() => (input.validationMessage = undefined));
    input.onDidAccept(() => {
      const value = input.value.trim();
      if (!value && !hasKey) {
        input.validationMessage = 'Enter a key';
        return;
      }
      done = true;
      resolve(value);
      input.hide();
    });
    input.onDidHide(() => {
      if (!done) resolve(undefined);
      input.dispose();
    });
    input.show();
  });
}

async function manageMemory(memory: MemoryStore): Promise<void> {
  type Item = vscode.QuickPickItem & { id: string };
  const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Forget this' };
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = 'ApexDev: Memory';
  pick.placeholder = 'What ApexDev remembers across chats — use the trash icon to forget an item';
  pick.matchOnDescription = true;
  const load = async () => {
    const all = await memory.all();
    pick.items = all
      .slice()
      .reverse()
      .map((m) => ({
        id: m.id,
        label: m.text,
        description: m.scope === 'global' ? 'all projects' : path.basename(m.workspace ?? ''),
        buttons: [deleteButton],
      }));
    if (!all.length) pick.placeholder = 'Nothing saved yet. Ask ApexDev to “remember …” and it will show up here.';
  };
  pick.onDidTriggerItemButton(async (e) => {
    await memory.remove(e.item.id);
    await load();
  });
  pick.onDidAccept(() => pick.hide());
  pick.onDidHide(() => pick.dispose());
  pick.show();
  await load();
}
