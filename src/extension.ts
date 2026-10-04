import * as path from 'path';
import * as vscode from 'vscode';
import { BrowserSession } from './browser/session';
import { DesktopHost } from './desktop/host';
import { ChatStore } from './history/store';
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
