// ApexDev chat panel. Talks to the extension host through postMessage.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const esc = window.escapeHtml;
  const md = window.renderMarkdown;
  const $ = (id) => document.getElementById(id);

  const log = $('log');
  const input = $('input');
  const form = $('composer');
  const sendBtn = $('send');
  const modeBtn = $('mode');
  const modelBtn = $('model');
  const mentionBtn = $('mention');
  const slashBtn = $('slash');
  const attachBtn = $('attach');
  const micBtn = $('mic');
  const menuEl = $('menu');
  const attachmentsEl = $('attachments');
  const noteEl = $('composer-note');
  const statusBar = $('status');
  const statusText = $('status-text');

  // Lucide icon paths (ISC license), 24×24, stroke-based.
  const ICONS = {
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    filePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    stop: '<rect width="12" height="12" x="6" y="6" rx="1.5" fill="currentColor" stroke="none"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
    mark: '<path d="M4 19 12 5l8 14"/><path d="M9.5 19h5"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    listChecks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    bug: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    circleDot: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
    circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    slash: '<rect width="18" height="18" x="3" y="3" rx="2"/><line x1="9" x2="15" y1="15" y2="9"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
    cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    sliders: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const TOOL_ICONS = {
    read_file: 'file',
    list_dir: 'folder',
    glob: 'search',
    grep: 'search',
    edit_file: 'pencil',
    write_file: 'filePlus',
    run_command: 'terminal',
    command_output: 'terminal',
    ide_diagnostics: 'alert',
    ide_state: 'code',
    open_file: 'file',
    ide_tasks: 'listChecks',
    run_task: 'play',
    debug: 'bug',
    vscode_command: 'code',
    task: 'bot',
    memory: 'lightbulb',
  };
  const PATH_TOOLS = new Set(['read_file', 'edit_file', 'write_file', 'open_file']);

  function toolIcon(e) {
    if (TOOL_ICONS[e.name]) return TOOL_ICONS[e.name];
    if (e.name.startsWith('browser_')) return 'globe';
    if (e.kind === 'interact' || e.name.startsWith('desktop_') || e.name.startsWith('ui_')) return 'monitor';
    return 'terminal';
  }

  const SUGGESTIONS = [
    'Explain how this project is structured and where the entry point is',
    'Run the tests, then fix whatever is failing',
    'Find TODO comments and list them by file with a short note on each',
  ];

  const planEl = $('plan');

  const state = {
    busy: false,
    config: null,
    recent: [],
    plan: null, // latest todo_write list
    planOpen: true,
    planCalls: new Set(), // ids of todo_write calls (rendered in the plan panel, not as cards)
    replaying: false,
    turn: null, // container for the current assistant turn
    textEl: null, // current streaming text segment
    textRaw: '',
    renderPending: false,
    tools: new Map(),
    attachments: [], // { name, url } images waiting to be sent
  };

  // ---------- helpers ----------

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }

  function append(node, parent) {
    const stick = nearBottom();
    (parent || log).appendChild(node);
    if (stick) log.scrollTop = log.scrollHeight;
    return node;
  }

  function keepScrolled(fn) {
    const stick = nearBottom();
    fn();
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function ensureTurn() {
    if (!state.turn) {
      removeEmpty();
      state.turn = append(el('section', 'turn'));
    }
    return state.turn;
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function removeEmpty() {
    const empty = log.querySelector('.empty');
    if (empty) empty.remove();
  }

  // ---------- empty state ----------

  function renderEmpty() {
    if (log.children.length && !log.querySelector('.empty')) return;
    removeEmpty();
    const cfg = state.config;
    const where = cfg && cfg.workspace
      ? `Working in <strong>${esc(cfg.workspace)}</strong>.`
      : 'No folder is open — ApexDev will work in your home folder.';

    const connect = cfg && cfg.needsKey
      ? `<div class="callout">
          <div class="callout-head">${icon('key')}<strong>Connect a model</strong></div>
          <p>ApexDev works with any OpenAI-compatible API. Current endpoint: <code>${esc(cfg.host)}</code> · <code>${esc(cfg.model)}</code></p>
          <div class="actions">
            <button type="button" class="btn primary" data-command="setApiKey">Add API key</button>
            <button type="button" class="btn ghost" data-command="openSettings">Change provider</button>
          </div>
        </div>`
      : '';

    const node = el(
      'div',
      'empty',
      `<div class="brand">${icon('mark', 'brand-mark')}<span>ApexDev</span></div>
       <h1>What should we build?</h1>
       <p class="lede">Describe a goal. ApexDev reads your code, plans the steps, edits files and runs commands — then checks the result. ${where}</p>
       ${connect}
       <div class="eyebrow">Try</div>
       <div class="suggestions">
         ${SUGGESTIONS.map((s) => `<button type="button" class="suggestion" data-suggest="${esc(s)}"><span>${esc(s)}</span>${icon('arrowRight')}</button>`).join('')}
       </div>
       ${renderRecent()}`,
    );
    log.appendChild(node);
  }

  function renderRecent() {
    if (!state.recent.length) return '';
    return `<div class="recent">
        <div class="recent-head"><span class="eyebrow">Recent chats</span><button type="button" class="link-btn" data-command="history">${icon('history')}All chats</button></div>
        <ul class="recent-list">
          ${state.recent
            .map(
              (c) =>
                `<li><button type="button" class="recent-item" data-chat="${esc(c.id)}">${icon('message')}<span class="recent-title">${esc(c.title)}</span><span class="recent-when">${esc(c.when)}</span></button></li>`,
            )
            .join('')}
        </ul>
      </div>`;
  }

  // ---------- plan panel ----------

  const PLAN_ICONS = { pending: 'circle', in_progress: 'circleDot', completed: 'circleCheck' };

  function updatePlan(todos) {
    if (!Array.isArray(todos)) return;
    state.plan = todos.filter((t) => t && typeof t.content === 'string');
    renderPlan();
  }

  function renderPlan() {
    const todos = state.plan;
    if (!todos || !todos.length) {
      planEl.hidden = true;
      planEl.innerHTML = '';
      return;
    }
    const done = todos.filter((t) => t.status === 'completed').length;
    const current = todos.find((t) => t.status === 'in_progress');
    const allDone = done === todos.length;
    planEl.hidden = false;
    planEl.classList.toggle('is-done', allDone);
    planEl.innerHTML =
      `<button type="button" class="plan-head" aria-expanded="${state.planOpen}" aria-controls="plan-list">` +
      `${icon('listChecks', 'plan-icon')}<span class="plan-title">Plan</span>` +
      `<span class="plan-count">${done}/${todos.length}</span>` +
      `<span class="plan-current">${esc(allDone ? 'All steps done' : current ? current.content : '')}</span>` +
      `${icon('chevron', 'plan-chevron')}</button>` +
      `<div class="plan-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${todos.length}" aria-valuenow="${done}" aria-label="Plan progress"><span></span></div>` +
      `<ol id="plan-list" class="plan-list"${state.planOpen ? '' : ' hidden'}>` +
      todos
        .map(
          (t) =>
            `<li class="plan-item" data-status="${esc(t.status)}">${icon(PLAN_ICONS[t.status] || 'circle', 'plan-mark')}<span>${esc(t.content)}</span></li>`,
        )
        .join('') +
      `</ol>`;
    // Inline style attributes are blocked by the CSP; CSSOM writes are not.
    planEl.querySelector('.plan-progress span').style.width = `${(done / todos.length) * 100}%`;
  }

  function clearPlan() {
    state.plan = null;
    state.planOpen = true;
    state.planCalls.clear();
    renderPlan();
  }

  planEl.addEventListener('click', (e) => {
    if (!e.target.closest('.plan-head')) return;
    state.planOpen = !state.planOpen;
    renderPlan();
  });

  // ---------- messages ----------

  /** `images` are data URLs (live send); `imageCount` comes from saved chats, which don't keep the pixels. */
  function addUserMessage(text, images, imageCount) {
    removeEmpty();
    state.turn = null;
    state.textEl = null;
    // A finished plan belongs to the previous request; an unfinished one may still be continued.
    if (state.plan && state.plan.every((t) => t.status === 'completed')) clearPlan();
    const node = el('div', 'msg-user');
    if (text) node.appendChild(el('div', 'msg-user-text')).textContent = text;
    if (images && images.length) {
      const row = node.appendChild(el('div', 'msg-user-images'));
      for (const src of images) {
        const img = row.appendChild(document.createElement('img'));
        img.src = src;
        img.alt = 'Attached image';
      }
    } else if (imageCount) {
      node.appendChild(el('div', 'msg-user-chip', `${icon('image')}${imageCount} image${imageCount > 1 ? 's' : ''} attached`));
    }
    append(node);
    log.scrollTop = log.scrollHeight;
  }

  function appendText(delta) {
    const turn = ensureTurn();
    if (!state.textEl) {
      state.textEl = append(el('div', 'md'), turn);
      state.textRaw = '';
    }
    state.textRaw += delta;
    if (!state.renderPending) {
      state.renderPending = true;
      requestAnimationFrame(flushText);
    }
  }

  function flushText() {
    state.renderPending = false;
    if (!state.textEl) return;
    const target = state.textEl;
    const raw = state.textRaw;
    keepScrolled(() => (target.innerHTML = md(raw)));
  }

  function closeTextSegment() {
    if (state.renderPending) flushText();
    state.textEl = null;
    state.textRaw = '';
  }

  function formatInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    const entries = Object.entries(input);
    if (entries.length === 1 && typeof entries[0][1] === 'string') return entries[0][1];
    return JSON.stringify(input, null, 2);
  }

  function addTool(e) {
    if (e.name === 'todo_write') {
      state.planCalls.add(e.id);
      updatePlan(e.input && e.input.todos);
      return;
    }
    closeTextSegment();
    const turn = ensureTurn();
    const card = el('div', 'tool');
    card.dataset.state = 'running';
    const path = PATH_TOOLS.has(e.name) && e.input && typeof e.input.path === 'string' ? e.input.path : null;
    card.innerHTML =
      `<button type="button" class="tool-head" aria-expanded="false">` +
      `${icon(toolIcon(e), 'tool-icon')}` +
      `<span class="tool-label">${esc(e.label)}</span>` +
      `<span class="tool-summary" title="${esc(e.summary)}">${esc(e.summary || (e.label ? '' : e.name))}</span>` +
      `<span class="tool-status"><span class="spinner" aria-label="Running"></span></span>` +
      `${icon('chevron', 'tool-chevron')}` +
      `</button>` +
      `<div class="tool-body" hidden>` +
      (path ? `<button type="button" class="link-btn" data-open="${esc(path)}">${icon('file')}Open ${esc(path)}</button>` : '') +
      `<div class="tool-section"><div class="tool-section-label">Input</div><pre>${esc(formatInput(e.input))}</pre></div>` +
      `<div class="tool-section tool-output" hidden><div class="tool-section-label">Output</div><pre></pre></div>` +
      `</div>`;
    append(card, turn);
    state.tools.set(e.id, card);
    setStatus(`${e.label} ${e.summary ? '· ' + e.summary : ''}`.trim());
  }

  function setToolProgress(id, message) {
    const card = state.tools.get(id);
    if (!card || card.dataset.state !== 'running') return;
    let line = card.querySelector('.tool-progress');
    if (!line) {
      line = el('div', 'tool-progress');
      keepScrolled(() => card.querySelector('.tool-head').after(line));
    }
    line.textContent = message;
    setStatus(message);
  }

  function finishTool(e) {
    if (state.planCalls.has(e.id)) {
      // A rejected plan is worth surfacing; a successful one is already in the panel.
      if (e.isError && !e.denied) addNotice('warning', e.output);
      return;
    }
    const card = state.tools.get(e.id);
    if (!card) return;
    card.dataset.state = e.denied ? 'denied' : e.isError ? 'error' : 'done';
    const statusIcon = e.denied ? icon('ban') : e.isError ? icon('x') : icon('check');
    const statusLabel = e.denied ? 'Denied' : e.isError ? 'Failed' : 'Done';
    card.querySelector('.tool-status').innerHTML = `<span title="${statusLabel}" aria-label="${statusLabel}">${statusIcon}</span>`;
    const progress = card.querySelector('.tool-progress');
    if (progress) progress.remove();
    const out = card.querySelector('.tool-output');
    out.hidden = false;
    out.querySelector('pre').textContent = e.output;
    if (Array.isArray(e.images) && e.images.length) addShots(card, e.images);
    // Errors open automatically so the user sees what went wrong.
    if (e.isError && !e.denied) toggleTool(card, true);
    if (!state.replaying) setStatus('Thinking');
  }

  /** Screenshots stay visible under the card header; click one to see it full width. */
  function addShots(card, images) {
    const strip = el('div', 'tool-shots');
    for (const src of images) {
      if (typeof src !== 'string' || !src.startsWith('data:image/')) continue;
      const button = el('button', 'shot');
      button.type = 'button';
      button.title = 'Click to enlarge';
      button.setAttribute('aria-label', 'Screenshot — click to enlarge');
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Screenshot returned by the tool';
      img.addEventListener('load', () => {
        if (nearBottom()) log.scrollTop = log.scrollHeight;
      });
      button.appendChild(img);
      strip.appendChild(button);
    }
    if (strip.children.length) keepScrolled(() => card.querySelector('.tool-head').after(strip));
  }

  /** Cards from an interrupted run (or a restored chat) that never got a result. */
  function settleRunningTools(label) {
    for (const card of state.tools.values()) {
      if (card.dataset.state !== 'running') continue;
      card.dataset.state = 'denied';
      card.querySelector('.tool-status').innerHTML = `<span title="${label}" aria-label="${label}">${icon('ban')}</span>`;
      const progress = card.querySelector('.tool-progress');
      if (progress) progress.remove();
    }
  }

  function toggleTool(card, open) {
    const head = card.querySelector('.tool-head');
    const body = card.querySelector('.tool-body');
    const expand = open ?? body.hidden;
    keepScrolled(() => {
      body.hidden = !expand;
      head.setAttribute('aria-expanded', String(expand));
    });
  }

  const PERMISSION_TITLES = {
    run_command: () => 'Run this command?',
    write_file: (s) => `Write ${s}?`,
    edit_file: (s) => `Edit ${s}?`,
  };

  function addPermission(p) {
    closeTextSegment();
    const fallback = (s) => `Allow ${p.label || p.name}${s ? ` · ${s}` : ''}?`;
    const title = (PERMISSION_TITLES[p.name] || fallback)(p.summary);
    const card = el('div', 'perm' + (p.dangerous ? ' perm-danger' : ''));
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Approval needed');
    card.innerHTML =
      `<div class="perm-head">${icon('shield')}<span class="perm-title">${esc(title)}</span></div>` +
      (p.dangerous ? `<p class="perm-warning">This command can delete data or change history. It always needs your approval.</p>` : '') +
      `<pre class="perm-detail${p.name === 'edit_file' ? ' diff' : ''}">${renderDetail(p)}</pre>` +
      `<div class="actions">` +
      `<button type="button" class="btn primary" data-decision="once">Allow</button>` +
      (p.dangerous ? '' : `<button type="button" class="btn secondary" data-decision="always" title="Don’t ask again for this tool in this chat">Always allow</button>`) +
      `<button type="button" class="btn ghost" data-decision="deny">Deny</button>` +
      `</div>`;
    card.dataset.id = p.id;

    // The approval belongs to the tool call that is waiting for it (the latest running card).
    const tool = [...state.tools.values()].reverse().find((t) => t.dataset.state === 'running');
    if (tool) {
      tool.classList.add('awaiting');
      tool.classList.toggle('awaiting-danger', Boolean(p.dangerous));
      toggleTool(tool, false);
      tool.querySelector('.tool-head').after(card);
    } else {
      append(card, ensureTurn());
    }
    log.scrollTop = log.scrollHeight;
    card.querySelector('[data-decision="once"]').focus({ preventScroll: true });
    setStatus('Waiting for your approval');
  }

  function renderDetail(p) {
    if (p.name !== 'edit_file') return esc(p.detail);
    return p.detail
      .split('\n')
      .map((line) => {
        const cls = line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : '';
        return `<span class="${cls}">${esc(line)}</span>`;
      })
      .join('\n');
  }

  function resolvePermission(card, decision) {
    vscode.postMessage({ type: 'permissionResponse', id: card.dataset.id, decision });
    closePermission(card, decision === 'deny' ? 'Denied' : decision === 'always' ? 'Always allowed in this chat' : 'Allowed', decision !== 'deny');
    input.focus();
  }

  /** Inside a tool card the prompt simply disappears (the card shows the outcome); standalone prompts collapse to a one-line result. */
  function closePermission(card, text, allowed) {
    const tool = card.closest('.tool');
    if (tool) {
      tool.classList.remove('awaiting', 'awaiting-danger');
      keepScrolled(() => card.remove());
      return;
    }
    card.classList.add('resolved', allowed ? 'is-allowed' : 'is-denied');
    card.querySelector('.actions').outerHTML = `<div class="perm-result">${icon(allowed ? 'check' : 'ban')}${text}</div>`;
  }

  function addNotice(level, message, action) {
    closeTextSegment();
    const kind = level === 'error' ? 'alert' : level === 'warning' ? 'alert' : 'info';
    const node = el('div', `notice notice-${level}`);
    const button = action
      ? `<button type="button" class="btn secondary" data-command="${esc(action)}">${action === 'setApiKey' ? 'Set API key' : 'Open settings'}</button>`
      : '';
    node.innerHTML = `${icon(kind)}<div class="notice-body"><p>${esc(message)}</p>${button}</div>`;
    append(node, state.turn || log);
    log.scrollTop = log.scrollHeight;
  }

  // ---------- busy / composer ----------

  function setBusy(busy) {
    state.busy = busy;
    statusBar.hidden = !busy;
    if (busy) setStatus('Thinking');
    sendBtn.innerHTML = busy ? icon('stop') : icon('arrowUp');
    sendBtn.title = busy ? 'Stop (Esc)' : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    sendBtn.classList.toggle('is-stop', busy);
    if (!busy) {
      closeTextSegment();
      // Any unanswered approval card is void once the run ends.
      log.querySelectorAll('.perm:not(.resolved)').forEach((card) => closePermission(card, 'Cancelled', false));
      settleRunningTools('Cancelled');
      // A finished plan folds away so it doesn't crowd the composer.
      if (state.plan && state.plan.length && state.plan.every((t) => t.status === 'completed') && state.planOpen) {
        state.planOpen = false;
        renderPlan();
      }
    }
    updateSendEnabled();
  }

  function updateSendEnabled() {
    sendBtn.disabled = !state.busy && !input.value.trim() && !state.attachments.length;
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    input.style.overflowY = input.scrollHeight > 200 ? 'auto' : 'hidden';
  }

  function afterInputChange() {
    autosize();
    updateSendEnabled();
  }

  function submit() {
    if (state.busy) {
      vscode.postMessage({ type: 'stop' });
      return;
    }
    const text = input.value.trim();
    const images = state.attachments.map((a) => a.url);
    if (!text && !images.length) return;
    closeMenu();
    addUserMessage(text, images);
    vscode.postMessage({ type: 'send', text, images });
    input.value = '';
    state.attachments = [];
    renderAttachments();
    afterInputChange();
  }

  const command = (name) => vscode.postMessage({ type: 'command', command: name });

  /** Inserts text at the caret, with a space before it when it would otherwise touch a word. */
  function insertAtCaret(text) {
    const start = input.selectionStart;
    const before = input.value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    input.focus();
    input.setRangeText(pad + text, start, input.selectionEnd, 'end');
    afterInputChange();
  }

  // ---------- composer: popover menu ----------

  // One menu at a time: inline (@ files, / commands — keys come from the textarea) or opened from a bar button.
  const menu = { kind: null, inline: false, items: [], active: -1, query: '', token: null, build: null, empty: '', onPick: null };

  function openMenu(opts) {
    menu.kind = opts.kind;
    menu.inline = Boolean(opts.inline);
    menu.build = opts.build;
    menu.empty = opts.empty;
    menu.onPick = opts.onPick;
    menuEl.className = `menu menu-${opts.align || 'full'}`;
    menuEl.innerHTML =
      (opts.title ? `<div class="menu-title">${esc(opts.title)}${opts.hint ? `<span>${esc(opts.hint)}</span>` : ''}</div>` : '') +
      (opts.search
        ? `<div class="menu-search">${icon('search')}<input type="text" spellcheck="false" placeholder="${esc(opts.search)}" aria-label="${esc(opts.search)}" aria-controls="menu-list" /></div>`
        : '') +
      `<ul id="menu-list" class="menu-list" role="listbox" tabindex="-1" aria-label="${esc(opts.title || 'Options')}"></ul>`;
    menuEl.hidden = false;
    document.querySelectorAll('[data-menu-trigger]').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.menuTrigger === opts.kind)));
    const search = menuEl.querySelector('.menu-search input');
    if (search) {
      search.addEventListener('input', () => filterMenu(search.value));
      search.addEventListener('keydown', menuKeys);
      search.focus();
    } else if (!menu.inline) {
      menuEl.querySelector('.menu-list').focus();
    }
    if (menu.inline) input.setAttribute('aria-controls', 'menu-list');
    filterMenu(opts.query || '');
  }

  function closeMenu() {
    if (!menu.kind) return;
    const wasInline = menu.inline;
    menu.kind = null;
    menu.inline = false;
    menu.token = null;
    menuEl.hidden = true;
    menuEl.innerHTML = '';
    input.removeAttribute('aria-activedescendant');
    input.removeAttribute('aria-controls');
    document.querySelectorAll('[data-menu-trigger]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (!wasInline && document.activeElement === document.body) input.focus();
  }

  function filterMenu(query) {
    if (!menu.kind) return;
    menu.query = query;
    menu.items = menu.build(query);
    // With nothing typed, start on the current choice (model, mode); otherwise on the best match.
    const checked = query ? -1 : menu.items.findIndex((i) => i.checked && !i.disabled);
    menu.active = checked >= 0 ? checked : menu.items.findIndex((i) => !i.disabled);
    renderMenuItems();
  }

  function renderMenuItems() {
    const list = menuEl.querySelector('.menu-list');
    if (!list) return;
    if (!menu.items.length) {
      const empty = typeof menu.empty === 'function' ? menu.empty() : menu.empty;
      list.innerHTML = `<li class="menu-empty">${esc(empty || 'No matches')}</li>`;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let section = null;
    list.innerHTML = menu.items
      .map((item, i) => {
        const head = item.section && item.section !== section ? `<li class="menu-section" role="presentation">${esc(item.section)}</li>` : '';
        section = item.section || section;
        const cls = ['menu-item', item.compact && 'is-compact', item.disabled && 'is-disabled', item.checked && 'is-checked', i === menu.active && 'is-active']
          .filter(Boolean)
          .join(' ');
        return (
          head +
          `<li id="menu-opt-${i}" class="${cls}" role="option" data-index="${i}" aria-selected="${i === menu.active}"${item.disabled ? ' aria-disabled="true"' : ''}>` +
          icon(item.icon || 'circle', 'menu-icon') +
          `<span class="menu-text"><span class="menu-label">${esc(item.label)}</span>${item.detail ? `<span class="menu-detail">${esc(item.detail)}</span>` : ''}</span>` +
          (item.hint ? `<span class="menu-hint">${esc(item.hint)}</span>` : '') +
          (item.checked ? icon('check', 'menu-check') : '') +
          `</li>`
        );
      })
      .join('');
    syncActive();
  }

  function syncActive() {
    menuEl.querySelectorAll('.menu-item').forEach((li) => {
      const on = Number(li.dataset.index) === menu.active;
      li.classList.toggle('is-active', on);
      li.setAttribute('aria-selected', String(on));
      if (!on) return;
      li.scrollIntoView({ block: 'nearest' });
      // Keep the heading in view when the first item of a section is active.
      const head = li.previousElementSibling;
      const list = li.parentElement;
      if (head && head.classList.contains('menu-section') && head.getBoundingClientRect().top < list.getBoundingClientRect().top) {
        list.scrollTop -= list.getBoundingClientRect().top - head.getBoundingClientRect().top;
      }
    });
    if (menu.inline && menu.active >= 0) input.setAttribute('aria-activedescendant', `menu-opt-${menu.active}`);
  }

  function moveActive(step) {
    const n = menu.items.length;
    if (!n) return;
    let i = menu.active;
    for (let tries = 0; tries < n; tries++) {
      i = (i + step + n) % n;
      if (!menu.items[i].disabled) break;
    }
    menu.active = i;
    syncActive();
  }

  function pickMenu(index) {
    const item = menu.items[index];
    if (!item || item.disabled) return;
    const { onPick, token } = menu;
    closeMenu();
    onPick(item, token);
  }

  /** Keyboard handling shared by the textarea, the menu search box and the menu list. Returns true when it used the key. */
  function menuKeys(e) {
    if (!menu.kind || e.isComposing) return false;
    switch (e.key) {
      case 'ArrowDown':
        moveActive(1);
        break;
      case 'ArrowUp':
        moveActive(-1);
        break;
      case 'Enter':
      case 'Tab':
        if (e.shiftKey || menu.active < 0) {
          if (menu.inline) closeMenu();
          if (menu.inline || e.key === 'Tab') return false;
          break;
        }
        pickMenu(menu.active);
        break;
      case 'Escape':
        closeMenu();
        input.focus();
        break;
      default:
        return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  menuEl.addEventListener('mousedown', (e) => {
    // Keep focus (and the caret) in the textarea or search box while clicking an option.
    if (!e.target.closest('.menu-search')) e.preventDefault();
  });
  menuEl.addEventListener('click', (e) => {
    const li = e.target.closest('.menu-item');
    if (li) pickMenu(Number(li.dataset.index));
  });
  menuEl.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.menu-item:not(.is-disabled)');
    if (li && Number(li.dataset.index) !== menu.active) {
      menu.active = Number(li.dataset.index);
      syncActive();
    }
  });
  menuEl.addEventListener('keydown', (e) => {
    if (e.target === menuEl.querySelector('.menu-list')) menuKeys(e);
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.kind || menuEl.contains(e.target) || e.target.closest('[data-menu-trigger]')) return;
    if (menu.inline && e.target === input) return;
    closeMenu();
  });

  /** Opens the menu, or closes it when its own trigger is clicked again. */
  function toggleMenu(kind, open) {
    if (menu.kind === kind && !menu.inline) closeMenu();
    else open();
  }

  // ---------- composer: @ files ----------

  const files = { list: [], folders: [], open: [], loadedAt: 0, loading: false };

  function requestFiles() {
    if (files.loading || Date.now() - files.loadedAt < 20000) return;
    files.loading = true;
    vscode.postMessage({ type: 'listFiles' });
  }

  function scorePath(p, q) {
    if (!q) return 0;
    const lower = p.toLowerCase();
    const base = lower.replace(/\/$/, '').split('/').pop();
    if (base.startsWith(q)) return 1;
    if (base.includes(q)) return 2;
    if (lower.includes(q)) return 3;
    let i = 0;
    for (const ch of lower) if (ch === q[i]) i++;
    return i === q.length ? 4 : -1;
  }

  function mentionItems(q) {
    const query = q.toLowerCase();
    const seen = new Set();
    const scored = [];
    const add = (p, folder, open) => {
      if (seen.has(p)) return;
      seen.add(p);
      const s = scorePath(p, query);
      if (s >= 0) scored.push({ p, folder, open, s: s - (open ? 0.5 : 0) + (folder ? 0.2 : 0) });
    };
    files.open.forEach((p) => add(p, false, true));
    files.list.forEach((p) => add(p, false, false));
    files.folders.forEach((p) => add(p, true, false));
    const depth = (p) => p.split('/').length;
    scored.sort((a, b) => a.s - b.s || depth(a.p) - depth(b.p) || a.p.localeCompare(b.p));
    return scored.slice(0, 50).map(({ p, folder, open }) => {
      const clean = p.replace(/\/$/, '');
      const cut = clean.lastIndexOf('/');
      return {
        path: clean,
        label: clean.slice(cut + 1) + (folder ? '/' : ''),
        detail: cut > 0 ? clean.slice(0, cut) : '',
        icon: folder ? 'folder' : 'file',
        hint: open ? 'open' : '',
        compact: true,
      };
    });
  }

  function openMentionMenu(query) {
    requestFiles();
    openMenu({
      kind: 'mention',
      inline: true,
      query,
      title: 'Add context',
      hint: '↑↓ to choose · Enter to add',
      build: mentionItems,
      empty: () =>
        state.config && !state.config.workspace
          ? 'Open a folder to mention its files'
          : files.loading && !files.loadedAt
            ? 'Loading files…'
            : 'No matching files or folders',
      onPick: (item, token) => {
        if (!token) return;
        input.setRangeText(`@${item.path} `, token.start, token.end, 'end');
        input.focus();
        afterInputChange();
      },
    });
  }

  // ---------- composer: / commands ----------

  const SLASH = [
    { id: 'explain', icon: 'lightbulb', detail: 'Explain code and how it fits in', template: 'Explain how this works and how it fits into the project: ' },
    { id: 'fix', icon: 'bug', detail: 'Find the cause of a bug and fix it', template: 'Find the cause of this bug and fix it: ' },
    { id: 'test', icon: 'play', detail: 'Run the tests and fix failures', template: 'Run the tests, then fix whatever is failing.' },
    {
      id: 'review',
      icon: 'search',
      detail: 'Review uncommitted changes',
      template: 'Review my uncommitted changes (git diff) for bugs, edge cases and readability, then list concrete fixes.',
    },
    {
      id: 'init',
      icon: 'filePlus',
      detail: 'Create APEXDEV.md project notes',
      template:
        'Read this project and create APEXDEV.md in the root: what it does, how to install, build, run and test it, the folder layout, and the code conventions to follow.',
    },
    { id: 'new', icon: 'plus', detail: 'Start a new chat', run: () => vscode.postMessage({ type: 'newChat' }) },
    { id: 'history', icon: 'history', detail: 'Open a previous chat', run: () => command('history') },
    { id: 'model', icon: 'cpu', detail: 'Switch the model', run: () => openModelMenu() },
    { id: 'mode', icon: 'shield', detail: 'Change when ApexDev asks first', run: () => openModeMenu() },
    { id: 'memory', icon: 'lightbulb', detail: 'View what ApexDev remembers', run: () => command('memory') },
    { id: 'key', icon: 'key', detail: 'Set or replace the API key', run: () => command('setApiKey') },
    { id: 'settings', icon: 'sliders', detail: 'Provider, model and other settings', run: () => command('openSettings') },
  ];

  function slashItems(q) {
    const query = q.toLowerCase().replace(/^\//, '');
    // Names win ("/fi" is /fix); descriptions are searched by word only when no name matches.
    const byName = SLASH.filter((c) => c.id.startsWith(query));
    const matches = byName.length
      ? byName
      : SLASH.filter((c) => c.detail.toLowerCase().split(/[^a-z0-9.]+/).some((w) => w.startsWith(query)));
    return matches.map((c) => ({
      ...c,
      label: `/${c.id}`,
      section: c.template ? 'Prompts' : 'Actions',
    }));
  }

  function openSlashMenu(query, inline) {
    openMenu({
      kind: 'slash',
      inline,
      query,
      title: inline ? 'Commands' : '',
      hint: inline ? 'Enter to run' : '',
      search: inline ? '' : 'Search commands',
      build: slashItems,
      empty: 'No command matches',
      onPick: (item, token) => {
        if (token) input.setRangeText('', token.start, token.end, 'end');
        if (item.template) {
          const rest = input.value.trim();
          input.value = item.template + rest;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        } else {
          item.run();
        }
        afterInputChange();
      },
    });
  }

  /** The `@query` or leading `/query` being typed at the caret, if any. */
  function inlineToken() {
    const caret = input.selectionStart;
    if (caret !== input.selectionEnd) return null;
    const before = input.value.slice(0, caret);
    let m = before.match(/^\/([\w-]*)$/);
    if (m) return { kind: 'slash', query: m[1], start: 0, end: caret };
    m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) return { kind: 'mention', query: m[1], start: caret - m[1].length - 1, end: caret };
    return null;
  }

  function updateInlineMenu() {
    const token = inlineToken();
    if (!token) {
      if (menu.inline) closeMenu();
      return;
    }
    if (menu.kind && !menu.inline) closeMenu();
    if (menu.kind !== token.kind) {
      if (token.kind === 'slash') openSlashMenu(token.query, true);
      else openMentionMenu(token.query);
    } else {
      filterMenu(token.query);
    }
    menu.token = token;
  }

  // ---------- composer: model and mode ----------

  const models = { list: [], recent: [], error: '', loading: false };

  function modelItems(q) {
    const query = q.trim().toLowerCase();
    const current = state.config ? state.config.model : '';
    const match = (m) => !query || m.toLowerCase().includes(query);
    const items = [];
    const recent = models.recent.filter(match);
    for (const m of recent) items.push({ model: m, label: m, icon: 'history', checked: m === current, section: 'Recent' });
    for (const m of models.list.filter((m) => match(m) && !recent.includes(m))) {
      items.push({ model: m, label: m, icon: 'cpu', checked: m === current, section: 'All models' });
    }
    if (current && !query && !items.some((i) => i.model === current)) {
      items.unshift({ model: current, label: current, icon: 'cpu', checked: true, section: 'Current' });
    }
    if (query && ![...models.list, ...models.recent].some((m) => m.toLowerCase() === query)) {
      // Below real matches so Enter picks a listed model; alone at the top when nothing matches.
      items.push({ model: q.trim(), label: `Use “${q.trim()}”`, detail: 'Any model ID your provider accepts', icon: 'arrowRight', section: 'Custom' });
    }
    if (models.error && !query) items.push({ label: models.error, icon: 'alert', disabled: true, section: 'Provider' });
    if (!query) {
      items.push({ action: 'openSettings', label: 'Change provider…', detail: 'Base URL and other settings', icon: 'sliders', section: 'Provider' });
      items.push({ action: 'setApiKey', label: 'Set API key…', icon: 'key', section: 'Provider' });
    }
    return items;
  }

  function openModelMenu() {
    models.loading = true;
    vscode.postMessage({ type: 'listModels' });
    openMenu({
      kind: 'model',
      align: 'right',
      title: 'Model',
      hint: state.config ? state.config.host : '',
      search: 'Search models or type an ID',
      build: modelItems,
      empty: () => (models.loading ? 'Loading models…' : 'No models found'),
      onPick: (item) => {
        if (item.action) return command(item.action);
        vscode.postMessage({ type: 'setModel', model: item.model });
        if (state.config) state.config.model = item.model;
        renderModel();
      },
    });
  }

  const MODES = {
    ask: { label: 'Ask mode', icon: 'shield', detail: 'Approve every edit and command first' },
    autoEdit: { label: 'Auto edits', icon: 'pencil', detail: 'Edits apply on their own; commands still ask' },
    fullAuto: { label: 'Auto mode', icon: 'bot', detail: 'Edits and commands run without asking — risky commands still ask' },
  };

  function openModeMenu() {
    const current = state.config ? state.config.mode : 'ask';
    openMenu({
      kind: 'mode',
      align: 'left',
      title: 'When should ApexDev ask?',
      build: () => Object.entries(MODES).map(([id, m]) => ({ id, ...m, checked: id === current })),
      onPick: (item) => {
        vscode.postMessage({ type: 'setMode', mode: item.id });
        if (state.config) state.config.mode = item.id;
        renderMode();
      },
    });
  }

  function renderMode() {
    const m = MODES[state.config && state.config.mode] || MODES.ask;
    modeBtn.innerHTML = `${icon(m.icon)}<span class="bar-label">${esc(m.label)}</span>${icon('chevronDown', 'chev')}`;
    modeBtn.title = `${m.label} — ${m.detail}`;
    modeBtn.setAttribute('aria-label', `Permission mode: ${m.label}`);
  }

  function renderModel() {
    const cfg = state.config;
    const name = cfg ? cfg.model : '…';
    modelBtn.innerHTML = `${icon('cpu')}<span class="bar-label">${esc(name)}</span>${icon('chevronDown', 'chev')}`;
    modelBtn.title = cfg ? `${cfg.model} via ${cfg.host} — change model` : 'Change model';
    modelBtn.setAttribute('aria-label', `Model: ${name}`);
  }

  // ---------- composer: images ----------

  const MAX_IMAGES = 6;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/;

  function addImages(list) {
    for (const img of list) {
      if (!img || typeof img.url !== 'string' || !img.url.startsWith('data:image/')) continue;
      if (state.attachments.length >= MAX_IMAGES) {
        showNote('warning', `Up to ${MAX_IMAGES} images per message.`);
        break;
      }
      state.attachments.push({ name: img.name || 'image', url: img.url });
    }
    renderAttachments();
    updateSendEnabled();
  }

  /** Reads image files from a paste or drop. Returns how many images it found. */
  function readImageFiles(fileList) {
    const images = [...fileList].filter((f) => IMAGE_MIME.test(f.type));
    for (const file of images) {
      if (file.size > MAX_IMAGE_BYTES) {
        showNote('warning', `${file.name || 'That image'} is larger than 8 MB.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => addImages([{ name: file.name || 'Pasted image', url: reader.result }]);
      reader.readAsDataURL(file);
    }
    return images.length;
  }

  function renderAttachments() {
    attachmentsEl.hidden = !state.attachments.length;
    attachmentsEl.innerHTML = '';
    state.attachments.forEach((a, i) => {
      const thumb = el('figure', 'thumb');
      const img = thumb.appendChild(document.createElement('img'));
      img.src = a.url;
      img.alt = a.name;
      thumb.title = a.name;
      const remove = el('button', 'thumb-remove', icon('x'));
      remove.type = 'button';
      remove.dataset.remove = String(i);
      remove.setAttribute('aria-label', `Remove ${a.name}`);
      thumb.appendChild(remove);
      attachmentsEl.appendChild(thumb);
    });
  }

  attachmentsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    state.attachments.splice(Number(b.dataset.remove), 1);
    renderAttachments();
    updateSendEnabled();
    input.focus();
  });

  input.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const found = readImageFiles(data.files);
    // Office apps put both text and a picture of it on the clipboard — keep the text in that case.
    if (found && !data.getData('text/plain')) e.preventDefault();
  });

  form.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer ? e.dataTransfer.types : [])].includes('Files')) return;
    e.preventDefault();
    form.classList.add('is-drop');
  });
  form.addEventListener('dragleave', (e) => {
    if (!form.contains(e.relatedTarget)) form.classList.remove('is-drop');
  });
  form.addEventListener('drop', (e) => {
    form.classList.remove('is-drop');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    if (!readImageFiles(e.dataTransfer.files)) showNote('warning', 'Only PNG, JPG, GIF and WebP images can be attached.');
  });

  // ---------- composer: voice ----------

  const voice = { state: 'idle', started: 0, timer: 0, noteTimer: 0 };

  function showNote(level, message) {
    clearTimeout(voice.noteTimer);
    if (voice.state !== 'idle') return;
    noteEl.hidden = false;
    noteEl.className = `composer-note note-${level}`;
    noteEl.innerHTML = `${icon('alert')}<span class="note-text">${esc(message)}</span><button type="button" class="note-close" data-voice="dismiss" aria-label="Dismiss">${icon('x')}</button>`;
    voice.noteTimer = setTimeout(hideNote, level === 'error' ? 10000 : 5000);
  }

  function hideNote() {
    if (voice.state === 'idle') noteEl.hidden = true;
  }

  function clock(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderVoice() {
    const s = voice.state;
    micBtn.classList.toggle('is-recording', s === 'recording');
    micBtn.classList.toggle('is-pending', s === 'starting' || s === 'transcribing');
    micBtn.innerHTML = s === 'recording' ? icon('stop') : icon('mic');
    const title = s === 'recording' ? 'Stop and transcribe' : s === 'idle' ? 'Voice input — speak instead of typing' : 'Working…';
    micBtn.title = title;
    micBtn.setAttribute('aria-label', title);
    micBtn.setAttribute('aria-pressed', String(s === 'recording'));
    if (s === 'idle') return;
    clearTimeout(voice.noteTimer);
    noteEl.hidden = false;
    noteEl.className = `composer-note note-voice is-${s}`;
    noteEl.innerHTML =
      s === 'recording'
        ? `<span class="rec-dot" aria-hidden="true"></span><span class="note-text">Listening — speak now</span><span class="voice-time">${clock(Date.now() - voice.started)}</span>` +
          `<button type="button" class="note-action" data-voice="cancel">Cancel</button><button type="button" class="note-action is-primary" data-voice="stop">Done</button>`
        : `<span class="spinner" aria-hidden="true"></span><span class="note-text">${s === 'starting' ? 'Starting microphone…' : 'Transcribing…'}</span>` +
          `<button type="button" class="note-action" data-voice="cancel">Cancel</button>`;
  }

  function setVoice(next) {
    voice.state = next;
    clearInterval(voice.timer);
    if (next === 'recording') {
      voice.started = Date.now();
      voice.timer = setInterval(() => {
        const t = noteEl.querySelector('.voice-time');
        if (t) t.textContent = clock(Date.now() - voice.started);
      }, 250);
    }
    if (next === 'idle') noteEl.hidden = true;
    renderVoice();
  }

  function toggleVoice() {
    if (voice.state === 'idle') {
      setVoice('starting');
      vscode.postMessage({ type: 'voiceStart' });
    } else if (voice.state === 'recording') {
      vscode.postMessage({ type: 'voiceStop' });
    }
  }

  function cancelVoice() {
    vscode.postMessage({ type: 'voiceCancel' });
    setVoice('idle');
    input.focus();
  }

  noteEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-voice]');
    if (!b) return;
    if (b.dataset.voice === 'stop') vscode.postMessage({ type: 'voiceStop' });
    else if (b.dataset.voice === 'cancel') cancelVoice();
    else {
      clearTimeout(voice.noteTimer);
      noteEl.hidden = true;
      input.focus();
    }
  });

  // ---------- composer: events ----------

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  input.addEventListener('keydown', (e) => {
    if (menu.inline && menuKeys(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', () => {
    afterInputChange();
    updateInlineMenu();
  });
  input.addEventListener('click', updateInlineMenu);
  input.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateInlineMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (menu.kind) {
      closeMenu();
      input.focus();
      return;
    }
    if (voice.state !== 'idle') {
      cancelVoice();
      return;
    }
    if (state.busy && !log.querySelector('.perm:not(.resolved)')) vscode.postMessage({ type: 'stop' });
  });

  modeBtn.addEventListener('click', () => toggleMenu('mode', openModeMenu));
  modelBtn.addEventListener('click', () => toggleMenu('model', openModelMenu));
  slashBtn.addEventListener('click', () => {
    if (!input.value.trim()) {
      input.value = '/';
      input.focus();
      input.setSelectionRange(1, 1);
      afterInputChange();
      updateInlineMenu();
    } else {
      toggleMenu('slash', () => openSlashMenu('', false));
    }
  });
  mentionBtn.addEventListener('click', () => {
    insertAtCaret('@');
    updateInlineMenu();
  });
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickImages' }));
  micBtn.addEventListener('click', toggleVoice);

  mentionBtn.innerHTML = icon('at');
  slashBtn.innerHTML = icon('slash');
  attachBtn.innerHTML = icon('image');
  renderMode();
  renderModel();
  renderVoice();

  log.addEventListener('click', (e) => {
    const t = e.target.closest('button, a, .file-ref');
    if (!t) return;

    if (t.matches('[data-decision]')) return resolvePermission(t.closest('.perm'), t.dataset.decision);
    if (t.matches('.tool-head')) return toggleTool(t.closest('.tool'));
    if (t.matches('[data-open]')) return vscode.postMessage({ type: 'openFile', path: t.dataset.open });
    if (t.matches('.file-ref')) {
      return vscode.postMessage({ type: 'openFile', path: t.dataset.file, line: t.dataset.line ? Number(t.dataset.line) : undefined });
    }
    if (t.matches('[data-link]')) {
      e.preventDefault();
      return vscode.postMessage({ type: 'openLink', url: t.dataset.link });
    }
    if (t.matches('[data-command]')) return vscode.postMessage({ type: 'command', command: t.dataset.command });
    if (t.matches('[data-chat]')) return vscode.postMessage({ type: 'openChat', id: t.dataset.chat });
    if (t.matches('.shot')) {
      keepScrolled(() => t.classList.toggle('is-zoomed'));
      t.title = t.classList.contains('is-zoomed') ? 'Click to shrink' : 'Click to enlarge';
      return;
    }
    if (t.matches('[data-copy]')) {
      const code = t.closest('.code-block').querySelector('code').textContent;
      navigator.clipboard.writeText(code).then(() => {
        t.textContent = 'Copied';
        setTimeout(() => (t.textContent = 'Copy'), 1200);
      });
      return;
    }
    if (t.matches('[data-suggest]')) {
      input.value = t.dataset.suggest;
      autosize();
      updateSendEnabled();
      input.focus();
    }
  });

  log.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.file-ref')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // ---------- saved chats ----------

  function resetLog() {
    log.innerHTML = '';
    state.turn = null;
    state.textEl = null;
    state.textRaw = '';
    state.tools.clear();
    clearPlan();
  }

  /** Redraws a saved chat from its recorded UI events. */
  function replay(events) {
    resetLog();
    state.replaying = true;
    try {
      for (const e of events) {
        switch (e.type) {
          case 'user':
            addUserMessage(e.text, null, e.imageCount);
            break;
          case 'turnStart':
            closeTextSegment();
            break;
          case 'text':
            appendText(e.delta);
            flushText();
            break;
          case 'toolStart':
            addTool(e);
            break;
          case 'toolEnd':
            finishTool(e);
            if (e.imageCount && state.tools.get(e.id)) {
              const out = state.tools.get(e.id).querySelector('.tool-output pre');
              out.textContent += `\n\n[${e.imageCount} screenshot(s) not kept in saved chats]`;
            }
            break;
          case 'notice':
            addNotice(e.level, e.message);
            break;
          case 'error':
            addNotice('error', e.message, e.action);
            break;
        }
      }
      closeTextSegment();
      if (!state.busy) settleRunningTools('Interrupted');
      if (state.plan && state.plan.every((t) => t.status === 'completed')) {
        state.planOpen = false;
        renderPlan();
      }
    } finally {
      state.replaying = false;
    }
    if (!log.children.length) renderEmpty();
    log.scrollTop = log.scrollHeight;
    input.focus();
  }

  // ---------- messages from the extension ----------

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'config':
        state.config = m;
        renderMode();
        renderModel();
        if (menu.kind === 'model' || menu.kind === 'mode') filterMenu(menu.query);
        if (log.querySelector('.empty') || !log.children.length) renderEmpty();
        break;
      case 'files':
        files.list = m.files || [];
        files.folders = m.folders || [];
        files.open = m.open || [];
        files.loading = false;
        files.loadedAt = Date.now();
        if (menu.kind === 'mention') filterMenu(menu.query);
        break;
      case 'models':
        models.list = m.models || [];
        models.recent = m.recent || [];
        models.error = m.error || '';
        models.loading = false;
        if (menu.kind === 'model') filterMenu(menu.query);
        break;
      case 'images':
        addImages(m.images || []);
        input.focus();
        break;
      case 'voice':
        if (m.state === 'recording' || m.state === 'transcribing') {
          // A late "recording" after the user already cancelled must not reopen the strip.
          if (voice.state !== 'idle') setVoice(m.state);
          break;
        }
        setVoice('idle');
        if (m.text) insertAtCaret(m.text);
        if (m.error) showNote('error', m.error);
        break;
      case 'busy':
        setBusy(m.value);
        break;
      case 'cleared':
        resetLog();
        renderEmpty();
        input.focus();
        break;
      case 'recent':
        state.recent = Array.isArray(m.chats) ? m.chats : [];
        if (log.querySelector('.empty')) {
          log.innerHTML = '';
          renderEmpty();
        }
        break;
      case 'restore':
        replay(m.events || []);
        break;
      case 'toolProgress':
        setToolProgress(m.id, m.message);
        break;
      case 'turnStart':
        closeTextSegment();
        setStatus('Thinking');
        break;
      case 'text':
        appendText(m.delta);
        break;
      case 'toolStart':
        addTool(m);
        break;
      case 'toolEnd':
        finishTool(m);
        break;
      case 'permission':
        addPermission(m);
        break;
      case 'notice':
        addNotice(m.level, m.message);
        break;
      case 'error':
        addNotice('error', m.message, m.action);
        break;
    }
  });

  setBusy(false);
  renderEmpty();
  input.focus();
  vscode.postMessage({ type: 'ready' });
})();
