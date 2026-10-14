// What is allowed through to the log pane — levels, text, noise, focus, trace —
// and the chips that show the current answer.

import { FRAMEWORK_CONTEXTS, el, escapeHtml, key, state, writePref } from './core.js';
import { renderLogs } from './logs.js';
import { closeMenu, isMenuOpen, openMenu } from './menus.js';
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
 * Renders the scope row: a chip per scoped service and for an active trace, as
 * many as fit, then "+N more" for the rest. The row exists only while a scope
 * does, so an unscoped view has one toolbar row.
 */
export function renderFocus() {
  const row = document.getElementById('filtersRow');
  const chips = document.getElementById('focusChips');
  const menu = document.getElementById('focusMenu');
  const trace = state.trace;
  const parts = [];
  // The trace goes first and is never folded away: it can be the whole reason
  // almost nothing is showing.
  if (trace !== null) {
    const full = `${trace.key} ${trace.value}`;
    parts.push(
      `<button class="chip trace" data-chip-trace="1" aria-label="Remove trace ${escapeHtml(full)}"
        title="Trace ${escapeHtml(full)} — remove">
        <span class="chip-label">${escapeHtml(trace.key)} ${escapeHtml(trace.value)}</span><span aria-hidden="true">&times;</span></button>`,
    );
  }
  for (const name of state.focus) {
    parts.push(
      `<button class="chip" data-chip="${escapeHtml(name)}" aria-label="Remove service filter ${escapeHtml(name)}"
        title="${escapeHtml(name)} — remove">
        <span class="chip-label">${escapeHtml(name)}</span><span aria-hidden="true">&times;</span></button>`,
    );
  }
  row.hidden = parts.length === 0;
  if (parts.length === 0) {
    chips.innerHTML = '';
    menu.innerHTML = '';
    closeMenu();
    return;
  }
  closeMenu();
  chips.innerHTML = `${parts.join('')}<button id="focusMore" class="chip more-chip" aria-haspopup="true"
    aria-expanded="false" aria-controls="focusMenu" hidden></button>`;
  menu.innerHTML = parts.join('');
  document.getElementById('focusMore').addEventListener('click', toggleMore);
  layoutChips();
}

let chipRegionWidth = 0;

/**
 * Decides how many chips fit in the row and folds the rest into "+N more". It
 * measures real rendered widths, so it runs when the filters change or the row is
 * resized — never per log line. The trace chip is placed first and keeps its
 * place; a trace too long for the row shrinks and ellipsizes instead.
 */
function layoutChips() {
  const chips = document.getElementById('focusChips');
  const more = document.getElementById('focusMore');
  if (!more) return;
  const all = [...chips.querySelectorAll('.chip:not(.more-chip)')];
  // Everything is shown first so it can be measured, then the overflow is hidden.
  for (const chip of all) chip.hidden = false;
  more.hidden = true;
  const room = chips.clientWidth;
  if (room === 0) return;
  const gap = Number.parseFloat(getComputedStyle(chips).columnGap) || 0;
  const widths = all.map((chip) => chip.offsetWidth);
  const total = widths.reduce((sum, width) => sum + width + gap, -gap);
  if (total <= room) return;

  // Room for the "+N more" button is held back before any chip is counted.
  let shown = 0;
  let used = 0;
  more.textContent = `+${all.length} more`;
  more.hidden = false;
  const reserve = more.offsetWidth + gap;
  for (const [index, width] of widths.entries()) {
    const next = used + (index === 0 ? 0 : gap) + width;
    // The first chip always stays: a row of nothing but "+N more" says nothing.
    if (index > 0 && next + reserve > room) break;
    used = next;
    shown += 1;
  }
  all.forEach((chip, index) => {
    chip.hidden = index >= shown;
  });
  const hiddenCount = all.length - shown;
  more.hidden = hiddenCount === 0;
  more.textContent = `+${hiddenCount} more`;
  more.title = `${hiddenCount} more active filter${hiddenCount === 1 ? '' : 's'}`;
  more.setAttribute('aria-label', `${hiddenCount} more active filters. Open the list.`);
}

/**
 * Opens or closes the full list of scoped services.
 * @param event - the click on "+N more"
 */
function toggleMore(event) {
  const menu = document.getElementById('focusMenu');
  if (isMenuOpen(menu)) closeMenu(true);
  else openMenu(menu, event.currentTarget);
}

// The chip region's width is decided by the window and the sidebar, so it is
// watched rather than polled; the callback bails unless the width really changed.
new ResizeObserver(() => {
  const width = document.getElementById('focusChips').clientWidth;
  if (width === chipRegionWidth) return;
  chipRegionWidth = width;
  layoutChips();
}).observe(document.getElementById('focusChips'));

/**
 * Applies a click on a filter chip, wherever the chip is shown.
 * @param event - the click
 */
function onChipClick(event) {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.chip) state.focus.delete(chip.dataset.chip);
  if (chip.dataset.chipTrace) state.trace = null;
  writePref('focus', [...state.focus]);
  renderServices();
  renderFocus();
  renderLogs();
}

document.getElementById('focusChips').addEventListener('click', onChipClick);
document.getElementById('focusMenu').addEventListener('click', onChipClick);

document.getElementById('clearFocus').addEventListener('click', () => {
  state.focus.clear();
  state.trace = null;
  writePref('focus', []);
  renderServices();
  renderFocus();
  renderLogs();
});

const LEVELS = ['error', 'warn', 'info', 'debug', 'raw'];
const levelBtn = document.getElementById('levelBtn');
const levelMenu = document.getElementById('levelMenu');

/**
 * Writes the dropdown's label from the levels currently allowed through.
 */
export function renderLevels() {
  const on = LEVELS.filter((level) => state.levels.has(level));
  for (const box of levelMenu.querySelectorAll('input')) box.checked = state.levels.has(box.dataset.level);
  const label = on.length === LEVELS.length ? 'All' : on.length === 0 ? 'None' : on.join(' ');
  levelBtn.textContent = `Levels: ${label} \u25BE`;
  levelBtn.classList.toggle('on', on.length !== LEVELS.length);
}

levelBtn.addEventListener('click', () => {
  if (isMenuOpen(levelMenu)) closeMenu(true);
  else openMenu(levelMenu, levelBtn);
});

levelMenu.addEventListener('change', (event) => {
  const level = event.target.dataset.level;
  if (event.target.checked) state.levels.add(level);
  else state.levels.delete(level);
  writePref('hiddenLevels', LEVELS.filter((l) => !state.levels.has(l)));
  renderLevels();
  renderLogs();
});

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
 * Applies the noise setting to the button and the log pane. The button reads as
 * pressed while noise is being hidden, which is what the filter actually does.
 */
export function applyNoise() {
  const hiding = !state.showNoise;
  noiseButton.classList.toggle('on', hiding);
  noiseButton.setAttribute('aria-pressed', String(hiding));
  writePref('showNoise', state.showNoise);
  renderLogs();
}

noiseButton.addEventListener('click', () => {
  state.showNoise = !state.showNoise;
  applyNoise();
});
