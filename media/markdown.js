// Small, safe Markdown renderer for chat messages. All text is HTML-escaped before formatting.
(function () {
  'use strict';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const FILE_REF = /^((?:[A-Za-z]:)?[\w.\-/\\@]+\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::\d+)?$/;

  function codeSpan(code) {
    const m = FILE_REF.exec(code);
    if (m && /[/\\.]/.test(m[1])) {
      return `<code class="file-ref" data-file="${esc(m[1])}" data-line="${m[2] || ''}" role="link" tabindex="0" title="Open in editor">${esc(code)}</code>`;
    }
    return `<code>${esc(code)}</code>`;
  }

  function inline(src) {
    const codes = [];
    let s = src.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-link="$2">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" data-link="$2">$2</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSpan(codes[Number(i)]));
    return s;
  }

  function codeBlock(code, lang) {
    return (
      `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(lang || 'text')}</span>` +
      `<button type="button" class="code-copy" data-copy>Copy</button></div>` +
      `<pre><code>${esc(code)}</code></pre></div>`
    );
  }

  const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isFence = (l) => /^\s*(```+|~~~+)/.test(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const isBlockStart = (l, next) =>
    isFence(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_ITEM.test(l) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || (l.includes('|') && next !== undefined && isTableSep(next));

  const splitRow = (l) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function render(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        const marker = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) buf.push(lines[i++]);
        i++;
        out.push(codeBlock(buf.join('\n'), fence[2]));
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const level = Math.min(heading[1].length, 4);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(
          '<div class="table-wrap"><table><thead><tr>' +
            head.map((c) => `<th>${inline(c)}</th>`).join('') +
            '</tr></thead><tbody>' +
            rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
            '</tbody></table></div>',
        );
        continue;
      }

      const item = LIST_ITEM.exec(line);
      if (item) {
        const baseIndent = item[1].length;
        const ordered = /\d/.test(item[2]);
        const start = ordered ? parseInt(item[2], 10) : 1;
        const items = [];
        while (i < lines.length) {
          const m = LIST_ITEM.exec(lines[i]);
          if (m && m[1].length <= baseIndent + 1) {
            items.push([m[3]]);
            i++;
            continue;
          }
          // continuation: indented lines (incl. nested lists) or blank lines followed by indented content
          if (items.length && lines[i].trim() && /^\s+/.test(lines[i]) && (lines[i].match(/^\s*/)[0].length > baseIndent)) {
            items[items.length - 1].push(lines[i].slice(Math.min(baseIndent + 2, lines[i].match(/^\s*/)[0].length)));
            i++;
            continue;
          }
          if (!lines[i].trim() && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && lines[i + 1].match(/^\s*/)[0].length > baseIndent) {
            items[items.length - 1].push('');
            i++;
            continue;
          }
          break;
        }
        const tag = ordered ? 'ol' : 'ul';
        const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
        out.push(
          `<${tag}${startAttr}>` +
            items
              .map(([first, ...rest]) => {
                const nested = rest.join('\n').trim();
                return `<li>${inline(first)}${nested ? render(nested) : ''}</li>`;
              })
              .join('') +
            `</${tag}>`,
        );
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) {
        para.push(lines[i++].trim());
      }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  window.renderMarkdown = render;
  window.escapeHtml = esc;
})();
