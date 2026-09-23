// What is allowed through to the log pane — levels, text, noise, focus, trace —
// and the chips that show the current answer.

import { FRAMEWORK_CONTEXTS, el, escapeHtml, key, state, writePref } from './core.js';
import { renderLogs } from './logs.js';
import { renderServices } from './services.js';

// Ids worth following a piece of work by. `userId` and `reqId` are the ones that
// actually appear in this codebase's payloads; the rest cost nothing to look for.
const TRACE_KEYS = ['reqId', 'userId', 'botId', 'botUserId', 'sessionId', 'campaignId', 'flowStepId'];

/**
 * Extracts the correlation ids carried by a record, from structured fields or
 * from a pretty-printed payload block. The result is cached on the record,
 * since filtering walks the whole buffer.
 * @param record - the log record
 * @returns the ids found, as key/value pairs
 */
export function correlationIds(record) {
  if (record.ids !== undefined) return record.ids;
  if (!record.fields) {
    record.ids = [];
    return record.ids;
  }
  const text = JSON.stringify(record.fields);
  const found = new Map();
  for (const key of TRACE_KEYS) {
    if (typeof record.fields[key] === 'string') {
      found.set(key, record.fields[key]);
      continue;
    }
    const match = new RegExp(`\\\\?"?\\b${key}\\b\\\\?"?\\s*:\\s*\\\\?"?([A-Za-z0-9_-]{6,})`).exec(text);
    if (match) found.set(key, match[1]);
  }
  record.ids = [...found].map(([key, value]) => ({ key, value }));
  return record.ids;
}

/**
 * Identifies lines that did not come from this repo: Nest's own bootstrap
 * logging and Nx/webpack build output. They are 78% of a typical session.
 * @param record - the log record
 * @returns true when the line is framework or build noise
 */
// Nx and webpack chatter, as opposed to a developer's own console.log — which
// also arrives unstructured, but is the whole point of being here.
const TOOLING_RE =
  /^(NX\s|>\s|Failed tasks\b|Hint:|View structured|Debugger listening|For help, see:|Nx read the output|chunk \(runtime|webpack compiled|Flaky tasks|asset\s|runtime modules|cacheable modules|modules by path|\.\/apps\/|\.\/libs\/|\s*\d+\s+modules?$|-\s\S+:\S+$)/;

function isNoise(record) {
  if (FRAMEWORK_CONTEXTS.has(record.context)) return true;
  // A raw line is only noise when it came from the build, never when it came
  // from the code being debugged.
  return record.level === 'raw' && TOOLING_RE.test(record.msg.trim());
}

/**
 * Decides whether a record passes the active level and text filters.
 * @param record - the log record
 * @returns true when the record should be shown
 */
export function passesFilters(record) {
  if (record.seq <= state.hiddenBelow) return false;
  if (!state.showNoise && isNoise(record)) return false;
  if (state.trace !== null && !correlationIds(record).some((id) => id.key === state.trace.key && id.value === state.trace.value)) {
    return false;
  }
  if (state.focus.size > 0 && !state.focus.has(key(record.repo, record.service))) return false;
  const buckets = { fatal: 'error', error: 'error', warn: 'warn', info: 'info', debug: 'debug', trace: 'debug' };
  if (!state.levels.has(buckets[record.level] ?? 'raw')) return false;
  if (state.search.length === 0) return true;
  const needle = state.search.toLowerCase();
  // The cheap fields first: most lines are decided here without touching the
  // payload at all.
  if (`${record.service} ${record.context ?? ''} ${record.msg}`.toLowerCase().includes(needle)) return true;
  return valueContains(record.fields, needle);
}

/**
 * Searches a structured payload in place. Serialising every record to JSON to
 * search it built a string per record per keystroke, and the payloads are the
 * biggest thing in the buffer; walking the value allocates nothing and stops at
 * the first hit.
 * @param value - any part of a record's payload
 * @param needle - the search text, already lowercased
 * @returns true when the text appears in a key or a value
 */
function valueContains(value, needle) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.toLowerCase().includes(needle);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).includes(needle);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (valueContains(entry, needle)) return true;
    }
    return false;
  }
  if (typeof value !== 'object') return false;
  for (const key in value) {
    if (key.toLowerCase().includes(needle) || valueContains(value[key], needle)) return true;
  }
  return false;
}

/**
 * Renders the chips showing which services the log pane is focused on.
 */
export function renderFocus() {
  const chips = document.getElementById('focusChips');
  const parts = [...state.focus].map(
    (name) => `<span class="chip" data-chip="${escapeHtml(name)}">${escapeHtml(name)} &times;</span>`,
  );
  if (state.trace !== null) {
    parts.push(
      `<span class="chip trace" data-chip-trace="1">${escapeHtml(state.trace.key)} ${escapeHtml(state.trace.value.slice(0, 10))} &times;</span>`,
    );
  }
  if (parts.length === 0) {
    chips.innerHTML = '<span class="hint">showing all services</span>';
    return;
  }
  // The chips scroll; "show all" sits outside that scroller so it is always reachable.
  chips.innerHTML = `<span class="chip-scroll">${parts.join('')}</span><button id="clearFocus" class="mini" title="clear the service filter and show every log again">clear all</button>`;
  const scroller = chips.querySelector('.chip-scroll');
  scroller.classList.toggle('overflowing', scroller.scrollWidth > scroller.clientWidth + 1);
  // A horizontal strip is scrolled with a vertical wheel in practice.
  scroller.addEventListener(
    'wheel',
    (event) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaY + event.deltaX;
    },
    { passive: false },
  );
}

document.getElementById('focusChips').addEventListener('click', (event) => {
  const chip = event.target.dataset?.chip;
  if (chip) state.focus.delete(chip);
  if (event.target.dataset?.chipTrace) state.trace = null;
  if (event.target.id === 'clearFocus') {
    state.focus.clear();
    state.trace = null;
  }
  renderServices();
  renderFocus();
  renderLogs();
});

for (const button of document.querySelectorAll('.lvlFilter')) {
  button.addEventListener('click', () => {
    const level = button.dataset.level;
    if (state.levels.has(level)) state.levels.delete(level);
    else state.levels.add(level);
    button.classList.toggle('on');
    renderLogs();
  });
}

let searchTimer = null;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = el.search.value;
    renderLogs();
  }, 120);
});

export const noiseButton = document.getElementById('noise');

/**
 * Applies the noise setting to the button and the log pane.
 */
export function applyNoise() {
  noiseButton.classList.toggle('on', state.showNoise);
  writePref('showNoise', state.showNoise);
  renderLogs();
}

noiseButton.addEventListener('click', () => {
  state.showNoise = !state.showNoise;
  applyNoise();
});

for (const button of document.querySelectorAll('.lvlFilter')) {
  button.addEventListener('click', () => {
    writePref('hiddenLevels', ['error', 'warn', 'info', 'debug', 'raw'].filter((l) => !state.levels.has(l)));
  });
}
