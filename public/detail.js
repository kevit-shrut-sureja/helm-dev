// The pane that opens on a log line: its payload, its ids, and the source line
// that printed it.

import { FRAMEWORK_CONTEXTS, el, escapeHtml, formatExactTime, post, state } from './core.js';
import { correlationIds, renderFocus } from './filters.js';
import { renderLogs, setFollow, stepSelection } from './logs.js';

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
      <h4>Payload</h4>
      <button class="mini copy-btn" data-copy="${escapeHtml(raw)}">Copy payload</button>
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

// What the origin lookup returned for the open line, for the copy-for-AI button.
let currentOrigin = null;
// Where focus was before the inspector opened, so closing it can put it back.
let returnFocus = null;

const ICON = (path) =>
  `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

/**
 * Whether the inspector is floating over the logs instead of sitting beside them.
 * @returns true in overlay mode with a line open
 */
function isOverlay() {
  return el.split.classList.contains('detail-open') && el.split.dataset.inspector === 'overlay';
}

/**
 * Describes the pane to assistive technology as what it currently is: a dialog
 * that holds the keyboard when it floats, an ordinary side panel when it does not.
 * Layout calls this when the window crosses the point where the mode changes.
 */
export function syncInspector() {
  const overlay = isOverlay();
  el.detail.setAttribute('role', overlay ? 'dialog' : 'complementary');
  if (overlay) el.detail.setAttribute('aria-modal', 'true');
  else el.detail.removeAttribute('aria-modal');
}

/**
 * Closes the inspector. A floating one hands focus back to where it came from;
 * a docked one only does so if focus was inside it, so a keyboard user is never
 * left on an element that no longer exists.
 */
export function closeDetail() {
  if (!el.split.classList.contains('detail-open')) return;
  const hadFocus = el.detail.contains(document.activeElement);
  const overlay = isOverlay();
  el.split.classList.remove('detail-open');
  syncInspector();
  if (overlay || hadFocus) (returnFocus?.isConnected ? returnFocus : el.logs).focus();
  returnFocus = null;
}

/**
 * Copies text and says so on the button without changing its width, so nothing
 * beside it moves. A refusal is shown too — a silent failure looks like success.
 * @param button - the button that was pressed
 * @param text - what to copy
 */
async function copyWithFeedback(button, text) {
  const original = button.innerHTML;
  button.style.minWidth = `${button.offsetWidth}px`;
  let failed = false;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    failed = true;
  }
  button.textContent = failed ? 'Copy failed' : 'Copied';
  button.classList.toggle('failed', failed);
  const status = document.getElementById('copyStatus');
  if (status) status.textContent = failed ? 'Copy failed: the browser blocked clipboard access.' : 'Copied to clipboard.';
  setTimeout(() => {
    button.innerHTML = original;
    button.classList.remove('failed');
  }, failed ? 2500 : 1200);
}

/**
 * Renders the detail pane for the selected log record.
 * @param record - the log record
 */
export async function showDetail(record) {
  currentOrigin = null;
  state.selected = record.seq;
  const wasOpen = el.split.classList.contains('detail-open');
  if (!wasOpen) returnFocus = document.activeElement;
  el.split.classList.add('detail-open');
  syncInspector();
  el.logs.setAttribute('aria-activedescendant', `row-${record.seq}`);
  for (const row of el.window.querySelectorAll('.row.selected')) {
    row.classList.remove('selected');
    row.setAttribute('aria-selected', 'false');
  }
  const selectedRow = el.window.querySelector(`.row[data-seq="${record.seq}"]`);
  selectedRow?.classList.add('selected');
  selectedRow?.setAttribute('aria-selected', 'true');

  const ids = correlationIds(record);
  const kv = (name, value) => `<div class="kv-row"><span class="kv-k">${name}</span><span class="kv-v">${value}</span></div>`;
  el.detail.innerHTML = `<header>
      <span class="lvl ${record.level}">${record.level}</span>
      <span class="dh-time">${formatExactTime(record.at).split(' ').pop()}</span>
      <span class="dh-svc" title="${escapeHtml(record.service)}">${escapeHtml(record.service)}</span>
      <span class="grow"></span>
      <button id="prevLine" class="icon-btn" title="previous line" aria-label="Previous line">${ICON('M3 8.5l4-4 4 4')}</button>
      <button id="nextLine" class="icon-btn" title="next line" aria-label="Next line">${ICON('M3 5.5l4 4 4-4')}</button>
      <button id="closeDetail" class="icon-btn" title="close (Esc)" aria-label="Close details">${ICON('M3.5 3.5l7 7M10.5 3.5l-7 7')}</button>
    </header>
    <div class="detail-actions">
      <button id="copyPrompt" title="copy this line, its payload, its origin and the lines before it as a prompt">&#10022; Copy for AI</button>
      <button class="copy-btn" data-copy="${escapeHtml(record.msg)}">Copy message</button>
      <span id="copyStatus" class="sr-only" role="status"></span>
    </div>
    <section>
      <h4>Message</h4>
      <pre class="msgbox">${escapeHtml(record.msg)}</pre>
    </section>
    <section>
      <h4>Fields</h4>
      <div class="kv">
        ${kv('Time', `${formatExactTime(record.at)}<span class="iso">${new Date(record.at).toISOString()}</span>`)}
        ${kv('Service', escapeHtml(state.workspaces.length > 1 && record.repo ? `${record.repo}/${record.service}` : record.service))}
        ${record.context ? kv('Context', escapeHtml(record.context)) : ''}
        ${ids
          .map((id) =>
            kv(
              escapeHtml(id.key),
              `<span class="id-val" title="${escapeHtml(id.value)}">${escapeHtml(id.value)}</span>
              <button class="mini trace-btn" data-key="${escapeHtml(id.key)}" data-value="${escapeHtml(id.value)}"
                title="show every line carrying this ${escapeHtml(id.key)}" aria-label="Trace ${escapeHtml(id.key)} ${escapeHtml(id.value)}">Trace</button>
              <button class="mini copy-btn" data-copy="${escapeHtml(id.value)}">Copy</button>`,
            ),
          )
          .join('')}
      </div>
    </section>
    <section id="originSection"><h4>Origin</h4><div class="origin">Resolving…</div></section>
    ${payloadSection(record.fields)}`;

  // A floating inspector takes the keyboard when it opens, not on every step.
  if (!wasOpen && isOverlay()) document.getElementById('closeDetail')?.focus();

  // Everything that does not depend on the origin lookup is wired first. It used
  // to be wired after, which meant one failing request left trace and close dead.
  wireDetailActions(record);
  loadOrigin(record);
}

/**
 * Lets a failed origin lookup be tried again in place.
 * @param section - the Origin section
 * @param record - the log record that is open
 */
function wireRetry(section, record) {
  section.querySelector('.origin-retry')?.addEventListener('click', () => {
    section.innerHTML = '<h4>Origin</h4><div class="origin">Resolving…</div>';
    loadOrigin(record);
  });
}

/**
 * Looks up where a line was logged from and fills the Origin section. Run again
 * by Retry, so a failed lookup does not cost the selection or a page reload.
 * @param record - the log record that is open
 */
async function loadOrigin(record) {
  const section = document.getElementById('originSection');
  if (!section) return;
  let origin;
  try {
    origin = await post('/api/resolve', {
      repo: record.repo,
      msg: record.msg,
      context: record.context,
      service: record.service,
    });
  } catch (error) {
    section.innerHTML = `<h4>Origin</h4><div class="origin"><span class="badge none">unavailable</span>
      <span>${escapeHtml(error.message)}</span> <button class="mini origin-retry">Retry</button></div>`;
    wireRetry(section, record);
    return;
  }
  // Stepping with the arrow keys outruns the lookup; an answer for a line that is
  // no longer open must not become the origin Copy for AI reports.
  if (!section || state.selected !== record.seq) return;
  currentOrigin = origin;

  if (!origin.match) {
    const kind = foreignKind(record);
    section.innerHTML = `<h4>Origin</h4>
      <div class="origin"><span class="badge ${kind ? 'foreign' : 'none'}">${kind ? 'not your code' : 'not found'}</span>
      <span>${kind ?? 'no indexed logger call matches this message'}</span></div>`;
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
      : `<div class="origin">Could not read the file: ${escapeHtml(snippet.error ?? 'unknown error')}
          <button class="mini origin-retry">Retry</button></div>`;

    const others = (origin.candidates ?? []).filter(
      (candidate) => candidate.file !== origin.match.file || candidate.line !== origin.match.line,
    );
    section.innerHTML = `<h4>Origin</h4>
      <div class="origin">
        <span class="badge ${origin.confidence}">${origin.confidence}</span>
        ${origin.match.kind === 'console' ? '<span class="badge temp">console.log — temporary debug</span>' : ''}
        ${origin.constant ? `<span class="badge">via ${escapeHtml(origin.constant)}</span>` : ''}
        <span class="path" id="openFile" role="button" tabindex="0">${escapeHtml(origin.match.file)}:${origin.match.line}</span>
        <button id="openBtn" class="open-btn">Open in editor</button>
      </div>
      <div class="snippet">${code}</div>
      ${
        others.length > 0
          ? `<div class="candidates">
              <p><strong>${others.length + 1} possible source locations.</strong> The same message is logged
              from each, so the line alone cannot tell them apart; the match above is a best guess. The others:</p>
              ${others
                .map(
                  (candidate) =>
                    `<div class="candidate"><span class="path candidate-open" role="button" tabindex="0"
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

  wireRetry(section, record);
  // Scoped to this section, never the document: by now another line may be open,
  // and its buttons must not be wired to this line's origin.
  /**
   * Makes a span act as a button for the keyboard as well as the pointer.
   * @param node - the element
   * @param action - what a click does
   */
  const activate = (node, action) => {
    node.addEventListener('click', action);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      node.click();
    });
  };
  for (const link of section.querySelectorAll('.candidate-open')) {
    activate(link, () => post('/api/open', { repo: record.repo, file: link.dataset.file, line: Number(link.dataset.line) }));
  }
  if (origin.match) {
    const open = () => post('/api/open', { repo: record.repo, file: origin.match.file, line: origin.match.line });
    section.querySelector('#openBtn')?.addEventListener('click', open);
    const path = section.querySelector('#openFile');
    if (path) activate(path, open);
  }
  // Show the matched line, not the top of the file excerpt.
  const box = section.querySelector('.snippet');
  const hit = section.querySelector('.snippet .hit');
  if (box && hit) box.scrollTop = Math.max(0, hit.offsetTop - box.offsetTop - (box.clientHeight - hit.offsetHeight) / 2);
}

/**
 * Wires the detail-pane buttons that work on the record alone — closing the pane
 * and tracing a correlation id — so they survive a failed origin lookup.
 */
function wireDetailActions(record) {
  document.getElementById('prevLine')?.addEventListener('click', () => stepSelection(-1));
  document.getElementById('nextLine')?.addEventListener('click', () => stepSelection(1));
  document.getElementById('copyPrompt')?.addEventListener('click', (event) => {
    copyWithFeedback(event.currentTarget, buildPrompt(record, currentOrigin));
  });
  document.getElementById('closeDetail')?.addEventListener('click', closeDetail);
  for (const button of el.detail.querySelectorAll('.trace-btn')) {
    button.addEventListener('click', () => {
      // Tracing means "show me everything about this", so any text filter is dropped.
      state.trace = { key: button.dataset.key, value: button.dataset.value };
      state.search = '';
      el.search.value = '';
      setFollow(false);
      renderFocus();
      renderLogs();
    });
  }
}

el.detail.addEventListener('click', (event) => {
  const button = event.target.closest('.copy-btn');
  if (button) copyWithFeedback(button, button.dataset.copy);
});

// A floating inspector holds the keyboard: Tab cycles inside it rather than
// walking off into the page behind, and a click on that page dismisses it.
el.detail.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !isOverlay()) return;
  const stops = [...el.detail.querySelectorAll('button:not(:disabled), [tabindex="0"], a[href]')];
  if (stops.length === 0) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === el.detail)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

document.addEventListener(
  'click',
  (event) => {
    if (!isOverlay() || el.detail.contains(event.target)) return;
    event.stopPropagation();
    event.preventDefault();
    closeDetail();
  },
  true,
);
