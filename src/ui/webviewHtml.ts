import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${media('chat.css')}" rel="stylesheet" />
  <title>ApexDev</title>
</head>
<body>
  <main id="log" class="log" role="log" aria-live="polite" aria-label="Conversation"></main>
  <footer class="composer-wrap">
    <section id="plan" class="plan" aria-label="Plan" hidden></section>
    <div id="status" class="status" hidden><span class="pulse" aria-hidden="true"></span><span id="status-text">Working</span></div>
    <form id="composer" class="composer">
      <div id="menu" class="menu" hidden></div>
      <div id="attachments" class="attachments" aria-label="Attached images" hidden></div>
      <div id="composer-note" class="composer-note" role="status" hidden></div>
      <label for="input" class="sr-only">Message ApexDev</label>
      <textarea id="input" rows="1" placeholder="Ask anything — @ files, / commands"
        title="Enter to send · Shift+Enter for a new line · @ adds files · / runs commands · paste or drop images" aria-autocomplete="list"></textarea>
      <div class="composer-bar">
        <button id="mode" class="bar-btn mode-btn" type="button" data-menu-trigger="mode" aria-haspopup="listbox"></button>
        <span class="bar-spacer"></span>
        <button id="mention" class="bar-btn icon-btn" type="button" title="Add a file or folder (@)" aria-label="Add a file or folder"></button>
        <button id="slash" class="bar-btn icon-btn" type="button" data-menu-trigger="slash" title="Commands (/)" aria-label="Commands"></button>
        <button id="attach" class="bar-btn icon-btn" type="button" title="Attach images — or paste / drop them here" aria-label="Attach images"></button>
        <button id="model" class="bar-btn model-btn" type="button" data-menu-trigger="model" aria-haspopup="listbox"></button>
        <button id="mic" class="bar-btn icon-btn mic-btn" type="button" title="Voice input" aria-label="Voice input"></button>
        <button id="send" class="send" type="submit" title="Send (Enter)" aria-label="Send"></button>
      </div>
    </form>
  </footer>
  <script nonce="${nonce}" src="${media('markdown.js')}"></script>
  <script nonce="${nonce}" src="${media('chat.js')}"></script>
</body>
</html>`;
}
