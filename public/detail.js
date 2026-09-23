// The pane that opens on a log line: its payload, its ids, and the source line
// that printed it.

import { FRAMEWORK_CONTEXTS, el, escapeHtml, formatExactTime, post, state } from './core.js';
import { correlationIds, renderFocus } from './filters.js';
import { renderLogs } from './logs.js';

/**
 * Builds the prompt handed to Claude for a selected log line.
 * @param record - the log record
 * @param origin - the resolved source location, when known
 * @returns the prompt text
 */
function buildPrompt(record, origin) {
  const where = origin?.match ? `${origin.match.file}:${origin.match.line}` : 'unresolved';
  const nearby = state.logs
    .filter((entry) => entry.service === record.service && entry.seq <= record.seq)
    .slice(-15)
    .map((entry) => `${entry.level}\t${entry.context ?? '-'}\t${entry.msg}`)
    .join('\n');

  return [
    `While running \`${record.service}\` locally I hit this log line:`,
    '',
    `    [${record.level}] ${record.context ?? ''} ${record.msg}`,
    '',
    `It is emitted from ${where}.`,
    record.fields ? `\nStructured payload:\n\`\`\`json\n${JSON.stringify(record.fields, null, 2)}\n\`\`\`` : '',
    `\nThe 15 preceding lines from the same service:\n\`\`\`\n${nearby}\n\`\`\``,
    '',
    'What does this log mean, what code path leads here, and what could be going wrong?',
  ].join('\n');
}

/**
 * Explains why a line has no source here, when the line did not come from this repo.
 * @param record - the log record
 * @returns a short explanation, or null when the line really should have resolved
 */
function foreignKind(record) {
  if (FRAMEWORK_CONTEXTS.has(record.context)) return 'Nest framework logging, emitted from node_modules';
  if (record.level === 'raw') return 'Nx / webpack build output, not application logging';
  if (/^\(node:\d+\)|^Warning:|KafkaJS|\[MONGOOSE\]/.test(record.msg)) return 'warning from a third-party library';
  return null;
}

/**
 * Renders a log record's payload. Structured fields print as JSON; the `detail`
 * block captured from pretty-printed output is already formatted text, so
 * JSON-encoding it would bury the content in escaped newlines.
 * @param fields - the record's payload, if any
 * @returns the payload section HTML, or an empty string
 */
function payloadSection(fields) {
  if (!fields) return '';
  const { detail, ...rest } = fields;
  const blocks = [];
  if (Object.keys(rest).length > 0) blocks.push(escapeHtml(JSON.stringify(rest, null, 2)));
  if (typeof detail === 'string') blocks.push(escapeHtml(dedent(detail)));
  if (blocks.length === 0) return '';
  const raw = [Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : '', typeof detail === 'string' ? dedent(detail) : '']
    .filter(Boolean)
    .join('\n');
  return `<section>
    <div class="section-head">
      <h4>payload</h4>
      <button class="mini copy-btn" data-copy="${escapeHtml(raw)}">copy payload</button>
    </div>
    <pre>${blocks.join('\n')}</pre>
  </section>`;
}

/**
 * Removes the common leading indentation a pretty-printer added to a block.
 * @param text - the captured detail block
 * @returns the block without its shared indent
 */
function dedent(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^ */)[0].length);
  const shave = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shave)).join('\n').trim();
}

/**
 * Renders the detail pane for the selected log record.
 * @param record - the log record
 */
export async function showDetail(record) {
  state.selected = record.seq;
  el.split.classList.add('detail-open');
  for (const row of el.window.querySelectorAll('.row.selected')) row.classList.remove('selected');
  el.window.querySelector(`.row[data-seq="${record.seq}"]`)?.classList.add('selected');

  el.detail.innerHTML = `<header><strong>${escapeHtml(record.service)}</strong>
      <span class="lvl ${record.level}">${record.level}</span>
      <span class="grow"></span>
      <button id="closeDetail">close</button>
    </header>
    <section>
      <div class="section-head">
        <h4>time</h4>
        <button class="mini copy-btn" data-copy="${formatExactTime(record.at)}">copy</button>
      </div>
      <pre class="exact-time">${formatExactTime(record.at)}<span class="iso">${new Date(record.at).toISOString()}</span></pre>
    </section>
    <section>
      <div class="section-head">
        <h4>message</h4>
        <button class="mini copy-btn" data-copy="${escapeHtml(record.msg)}">copy message</button>
      </div>
      <pre>${escapeHtml(record.msg)}</pre>
      ${correlationIds(record).length > 0 ? '<h4 style="margin-top:12px">ids</h4>' : ''}
      ${correlationIds(record)
        .map(
          (id) => `<div class="id-row">
            <code class="id-key">${escapeHtml(id.key)}</code>
            <span class="id-val" title="${escapeHtml(id.value)}">${escapeHtml(id.value)}</span>
            <button class="mini trace-btn" data-key="${escapeHtml(id.key)}" data-value="${escapeHtml(id.value)}"
              title="show every line carrying this ${escapeHtml(id.key)}">trace</button>
            <button class="mini copy-btn" data-copy="${escapeHtml(id.value)}">copy</button>
          </div>`,
        )
        .join('')}
    </section>
    <section id="originSection"><h4>origin</h4><div class="origin">resolving…</div></section>
    ${payloadSection(record.fields)}`;

  // Everything that does not depend on the origin lookup is wired first. It used
  // to be wired after, which meant one failing request left trace and close dead.
  wireDetailActions();

  const section = document.getElementById('originSection');
  let origin;
  try {
    origin = await post('/api/resolve', {
      repo: record.repo,
      msg: record.msg,
      context: record.context,
      service: record.service,
    });
  } catch (error) {
    if (section) {
      section.innerHTML = `<h4>origin</h4><div class="origin"><span class="badge none">unavailable</span>
        <span>${escapeHtml(error.message)}</span></div>`;
    }
    return;
  }
  if (!section) return;

  if (!origin.match) {
    const kind = foreignKind(record);
    section.innerHTML = `<h4>origin</h4>
      <div class="origin"><span class="badge ${kind ? 'foreign' : 'none'}">${kind ? 'not your code' : 'not found'}</span>
      <span>${kind ?? 'no indexed logger call matches this message'}</span></div>
      <div style="margin-top:8px"><button id="copyPrompt">copy Claude prompt</button></div>`;
  } else {
    const snippet = await post('/api/source', {
      repo: record.repo,
      file: origin.match.file,
      line: origin.match.line,
      radius: 10,
    }).catch((error) => ({ error: error.message }));
    // The file may have moved since it was indexed; the origin is still worth
    // showing without the code around it.
    const code = Array.isArray(snippet.lines)
      ? snippet.lines
          .map((text, offset) => {
            const lineNumber = snippet.from + offset;
            const hit = lineNumber === origin.match.line ? ' class="hit"' : '';
            return `<div${hit}><span class="ln">${lineNumber}</span>${escapeHtml(text)}</div>`;
          })
          .join('')
      : `<div class="muted">could not read the file: ${escapeHtml(snippet.error ?? 'unknown error')}</div>`;

    const others = (origin.candidates ?? []).filter(
      (candidate) => candidate.file !== origin.match.file || candidate.line !== origin.match.line,
    );
    section.innerHTML = `<h4>origin</h4>
      <div class="origin">
        <span class="badge ${origin.confidence}">${origin.confidence}</span>
        ${origin.match.kind === 'console' ? '<span class="badge temp">console.log — temporary debug</span>' : ''}
        ${origin.constant ? `<span class="badge">via ${escapeHtml(origin.constant)}</span>` : ''}
        <span class="path" id="openFile">${escapeHtml(origin.match.file)}:${origin.match.line}</span>
      </div>
      <div style="margin:8px 0"><button id="openBtn">open in VSCode</button>
        <button id="copyPrompt">copy Claude prompt</button></div>
      <div class="snippet">${code}</div>
      ${
        others.length > 0
          ? `<div class="candidates">
              <p>This exact message is logged from ${others.length + 1} places. It cannot be told
              apart from the line alone — the others are:</p>
              ${others
                .map(
                  (candidate) =>
                    `<div class="candidate"><span class="path candidate-open"
                      data-file="${escapeHtml(candidate.file)}" data-line="${candidate.line}"
                      >${escapeHtml(candidate.file)}:${candidate.line}</span>${
                      candidate.class ? ` <span class="cand-class">${escapeHtml(candidate.class)}</span>` : ''
                    }</div>`,
                )
                .join('')}
            </div>`
          : ''
      }`;
  }

  for (const link of section.querySelectorAll('.candidate-open')) {
    link.addEventListener('click', () => post('/api/open', { repo: record.repo, file: link.dataset.file, line: Number(link.dataset.line) }));
  }
  const open = () => post('/api/open', { repo: record.repo, file: origin.match.file, line: origin.match.line });
  document.getElementById('openBtn')?.addEventListener('click', open);
  document.getElementById('openFile')?.addEventListener('click', open);
  document.getElementById('copyPrompt')?.addEventListener('click', async (event) => {
    await navigator.clipboard.writeText(buildPrompt(record, origin));
    event.target.textContent = 'copied ✓';
  });
}

/**
 * Wires the detail-pane buttons that work on the record alone — closing the pane
 * and tracing a correlation id — so they survive a failed origin lookup.
 */
function wireDetailActions() {
  document.getElementById('closeDetail')?.addEventListener('click', () => {
    el.split.classList.remove('detail-open');
  });
  for (const button of el.detail.querySelectorAll('.trace-btn')) {
    button.addEventListener('click', () => {
      // Tracing means "show me everything about this", so any text filter is dropped.
      state.trace = { key: button.dataset.key, value: button.dataset.value };
      state.search = '';
      el.search.value = '';
      state.follow = false;
      document.getElementById('follow').classList.remove('on');
      renderFocus();
      renderLogs();
    });
  }
}

el.detail.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-btn');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    const original = button.textContent;
    button.textContent = 'copied ✓';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch {
    button.textContent = 'copy blocked';
  }
});
