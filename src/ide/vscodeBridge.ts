import * as vscode from 'vscode';
import type { Diagnostic, EditorState, IdeBridge } from '../tools/types';

const SEVERITY: Record<number, Diagnostic['severity']> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

function toDiagnostic(uri: vscode.Uri, d: vscode.Diagnostic): Diagnostic {
  const code = typeof d.code === 'object' ? d.code.value : d.code;
  return {
    path: uri.fsPath,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: SEVERITY[d.severity] ?? 'info',
    message: d.message.replace(/\s+/g, ' ').trim(),
    source: d.source,
    code: code === undefined ? undefined : String(code),
  };
}

function samePath(a: vscode.Uri, absPath: string): boolean {
  return process.platform === 'win32' ? a.fsPath.toLowerCase() === absPath.toLowerCase() : a.fsPath === absPath;
}

/** Gives tools access to the editor: problems, open files, tasks and debugging. */
export class VsCodeBridge implements IdeBridge {
  async diagnostics(absPath?: string, waitMs = 0): Promise<Diagnostic[]> {
    if (!absPath) {
      return vscode.languages.getDiagnostics().flatMap(([uri, list]) => list.map((d) => toDiagnostic(uri, d)));
    }
    const uri = vscode.Uri.file(absPath);
    if (waitMs > 0) {
      // Opening the document makes its language server analyse it; wait for the first report.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        const sub = vscode.languages.onDidChangeDiagnostics((e) => {
          if (e.uris.some((u) => samePath(u, absPath))) setTimeout(done, 150);
        });
        function done() {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
        vscode.workspace.openTextDocument(uri).then(undefined, done);
      });
    }
    return vscode.languages.getDiagnostics(uri).map((d) => toDiagnostic(uri, d));
  }

  editorState(): EditorState {
    const editor = vscode.window.activeTextEditor;
    let selection: EditorState['selection'];
    if (editor && !editor.selection.isEmpty) {
      const text = editor.document.getText(editor.selection);
      selection = {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: text.length > 8000 ? `${text.slice(0, 8000)}\n… (${text.length} chars)` : text,
      };
    }
    const openEditors = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri.fsPath : undefined))
      .filter((p): p is string => Boolean(p));
    let errors = 0;
    let warnings = 0;
    for (const [, list] of vscode.languages.getDiagnostics()) {
      for (const d of list) {
        if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      }
    }
    return {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      activeFile: editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : editor?.document.uri.toString(),
      cursor: editor ? { line: editor.selection.active.line + 1, column: editor.selection.active.character + 1 } : undefined,
      selection,
      openEditors: [...new Set(openEditors)],
      unsavedFiles: vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.fsPath),
      terminals: vscode.window.terminals.map((t) => t.name),
      debugSessions: vscode.debug.activeDebugSession ? [vscode.debug.activeDebugSession.name] : [],
      problems: { errors, warnings },
    };
  }

  async openFile(absPath: string, line?: number, column?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(position, position),
      preview: false,
      preserveFocus: true,
    });
  }

  async listTasks() {
    const tasks = await vscode.tasks.fetchTasks();
    return tasks.map((t) => ({ name: t.name, source: t.source, group: t.group?.id }));
  }

  async runTask(name: string, timeoutMs: number, signal: AbortSignal) {
    const tasks = await vscode.tasks.fetchTasks();
    const wanted = name.toLowerCase();
    const task =
      tasks.find((t) => t.name.toLowerCase() === wanted) ??
      tasks.find((t) => `${t.source}: ${t.name}`.toLowerCase() === wanted) ??
      tasks.find((t) => t.name.toLowerCase().includes(wanted));
    if (!task) {
      throw new Error(`No task named "${name}". Available: ${tasks.map((t) => t.name).join(', ') || 'none'}.`);
    }
    const execution = await vscode.tasks.executeTask(task);
    return new Promise<{ exitCode?: number; timedOut: boolean }>((resolve) => {
      const subs: vscode.Disposable[] = [];
      const finish = (result: { exitCode?: number; timedOut: boolean }) => {
        clearTimeout(timer);
        subs.forEach((s) => s.dispose());
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => {
        execution.terminate();
        finish({ timedOut: false });
      };
      const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
      signal.addEventListener('abort', onAbort);
      subs.push(
        vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution === execution) finish({ exitCode: e.exitCode, timedOut: false });
        }),
        // Tasks without a process (e.g. compound tasks) only report the end.
        vscode.tasks.onDidEndTask((e) => {
          if (e.execution === execution) setTimeout(() => finish({ timedOut: false }), 100);
        }),
      );
    });
  }

  async startDebugging(configName?: string): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const configs = vscode.workspace.getConfiguration('launch', folder?.uri).get<Array<{ name: string }>>('configurations', []);
    const name = configName ?? configs[0]?.name;
    if (!name) throw new Error('No launch configurations found in .vscode/launch.json.');
    const started = await vscode.debug.startDebugging(folder, name);
    return started ? `Started debug session "${name}".` : `Could not start "${name}". Check the Debug Console.`;
  }

  async stopDebugging(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) return 'No debug session is running.';
    await vscode.debug.stopDebugging(session);
    return `Stopped debug session "${session.name}".`;
  }

  executeCommand(command: string, args: unknown[]): Promise<unknown> {
    return Promise.resolve(vscode.commands.executeCommand(command, ...args));
  }
}
