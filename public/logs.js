// The log pane. Only the rows in view exist as DOM; the rest is arithmetic.

import { el, escapeHtml, formatDuration, formatTime, post, state, workspaceOf, writePref } from './core.js';
import { closeDetail, showDetail } from './detail.js';
import { passesFilters } from './filters.js';
import { serviceState } from './services.js';

/**
 * Builds the markup for one log row.
 * @param record - the log record
 * @returns the row HTML
 */
function rowHtml(row) {
  const record = row.record;
  const selected = record.seq === state.selected ? ' selected' : '';
  const member = row.member ? ' member' : '';
  const identity = state.workspaces.length > 1 && record.repo ? `${record.repo}/${record.service}` : record.service;
  return `<div class="row ${record.level}${selected}${member}" id="row-${record.seq}" data-seq="${record.seq}" role="option" aria-selected="${record.seq === state.selected}">
    <span class="time">${formatTime(record.at)}</span>
    <span class="svc" title="${escapeHtml(identity)}">${escapeHtml(identity)}</span>
    <span class="lvl ${record.level}">${record.level}</span>
    <span class="msg">${record.context ? `<span class="ctx">${escapeHtml(record.context)}</span>` : ''}${escapeHtml(record.msg)}</span>
    ${row.repeat > 1 ? `<span class="repeat" data-group="${row.groupId}" title="show each of the ${row.repeat} occurrences">&times;${row.repeat} &#9662;</span>` : ''}
    ${row.member ? `<span class="repeat open${row.first ? ' pinned' : ''}" data-group="${row.groupId}" title="collapse these ${row.total} back to one row">&times;${row.total} &#9652;</span>` : ''}
  </div>`;
}

/**
 * Repaints the whole log pane, used after a filter change or a bulk load.
 */
/**
 * Folds runs of identical consecutive lines into one row carrying a count;
 * a fifth of a typical session is the same line repeated.
 * @param records - the filtered records, in order
 * @returns rows of { record, repeat }
 */
/**
 * True when two records are the same line repeated.
 * @param a - one record
 * @param b - the other record
 * @returns whether they fold together
 */
function sameLine(a, b) {
  return a.service === b.service && a.msg === b.msg && a.level === b.level;
}

/**
 * Folds runs of identical consecutive lines into one row carrying a count. A run
 * the viewer has expanded is emitted as its individual lines instead, so the
 * timestamps and payloads of each occurrence stay reachable.
 * @param records - the filtered records, in order
 * @returns rows ready to render
 */
function collapse(records) {
  const groups = [];
  for (const record of records) {
    const group = groups[groups.length - 1];
    if (group && sameLine(group.records[0], record)) {
      group.records.push(record);
      continue;
    }
    groups.push({ id: record.seq, records: [record] });
  }

  const rows = [];
  for (const group of groups) {
    const total = group.records.length;
    if (total === 1) {
      rows.push({ record: group.records[0], records: group.records, repeat: 1, groupId: group.id });
    } else if (state.expanded.has(group.id)) {
      group.records.forEach((record, index) => {
        rows.push({ record, records: group.records, repeat: 1, groupId: group.id, member: true, first: index === 0, total });
      });
    } else {
      rows.push({ record: group.records[total - 1], records: group.records, repeat: total, groupId: group.id });
    }
  }
  return rows;
}

/**
 * Reads the log row height the current density asks for.
 * @returns the height in pixels
 */
function readRowHeight() {
  const declared = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--log-row-height'));
  if (declared > 0) return declared;
  return FALLBACK_ROW_HEIGHT[document.documentElement.dataset.density] ?? FALLBACK_ROW_HEIGHT.readable;
}

// The server owns the budget; the tab mirrors it so it cannot outgrow it either.
let bufferBudgetBytes = 50 * 1024 * 1024;

/**
 * Mirrors the server's buffer budget, which the tab learns at boot.
 * @param megabytes - the budget the server is enforcing
 */
export function setBufferBudget(megabytes) {
  bufferBudgetBytes = megabytes * 1024 * 1024;
}

// The density's row height, read from CSS once and again when the density changes —
// never per line, and never by measuring a row. These are only the fallback for a
// stylesheet that has not applied yet; --log-row-height is the source of truth.
const FALLBACK_ROW_HEIGHT = { readable: 30, compact: 26 };
let rowHeight = readRowHeight();
const OVERSCAN = 12;
let visibleRecords = [];
let paintQueued = false;
// Set when the number of rows changed, so the next frame rewrites the spacer,
// the counter and the scroll position — once, however many lines arrived.
let metricsDirty = false;

/**
 * Recomputes which records pass the filters, then repaints the visible window.
 * Only the rows on screen are ever put in the DOM.
 */
/**
 * Identifies the line currently at the top of the viewport, so a re-filter can
 * put the viewer back where they were instead of at an arbitrary offset.
 * @returns the anchor, or null when the pane is empty
 */
function currentAnchor() {
  if (visibleRecords.length === 0) return null;
  const index = Math.min(visibleRecords.length - 1, Math.floor(el.logs.scrollTop / rowHeight));
  return { seq: visibleRecords[index].record.seq, offset: index * rowHeight - el.logs.scrollTop };
}

/**
 * Scrolls so a given line sits where it was before the list changed.
 * @param anchor - the anchor captured before re-rendering
 */
function restoreAnchor(anchor) {
  if (anchor === null) return;
  let index = visibleRecords.findIndex((row) => row.record.seq >= anchor.seq);
  if (index === -1) index = visibleRecords.length - 1;
  const max = Math.max(0, visibleRecords.length * rowHeight - el.logs.clientHeight);
  el.logs.scrollTop = Math.max(0, Math.min(max, index * rowHeight - anchor.offset));
}

/**
 * Re-reads the row height after the density changed and lays the list out again
 * without losing the viewer's place. The line at the top of the pane is the
 * anchor: its sequence number and how far into its row the pane was scrolled,
 * as a fraction so it carries across heights. While following, the pane stays
 * on the newest line instead.
 */
export function applyDensity() {
  const before = rowHeight;
  const after = readRowHeight();
  if (after === before) return;

  let anchor = null;
  if (!state.follow && visibleRecords.length > 0) {
    const index = Math.min(visibleRecords.length - 1, Math.floor(el.logs.scrollTop / before));
    anchor = { seq: visibleRecords[index].record.seq, within: (el.logs.scrollTop - index * before) / before };
  }

  rowHeight = after;
  const viewport = el.logs.clientHeight;
  writeMetrics(viewport);
  if (anchor !== null) {
    // The line may have been evicted since; the first one at or after it is the
    // nearest that still exists, as for every other re-render here.
    let index = visibleRecords.findIndex((row) => row.record.seq >= anchor.seq);
    let within = anchor.within;
    if (index === -1) {
      index = visibleRecords.length - 1;
      within = 0;
    }
    const max = Math.max(0, visibleRecords.length * rowHeight - viewport);
    el.logs.scrollTop = Math.min(max, (index + within) * rowHeight);
  }
  paintWindow();
}

/**
 * Records whether the pane is following the newest line, and says so.
 * @param following - true to follow, false once the viewer has scrolled away
 */
export function setFollow(following) {
  state.follow = following;
  document.getElementById('follow').classList.toggle('on', following);
  renderFollowLabel();
}

// False while the event stream is down. "Following latest" describes where the
// viewport is, not whether lines are arriving, so it must not read as a promise
// of fresh output while nothing is.
let streamLive = true;

/**
 * Says what the pane is doing about the newest line. Paused means the viewport
 * stopped following; lines keep arriving regardless.
 */
function renderFollowLabel() {
  let label = 'Auto-scroll paused';
  if (state.follow) label = streamLive ? 'Following latest' : 'Auto-scroll on';
  document.getElementById('followState').textContent = label;
}

/**
 * Records whether the event stream is connected, and shows it in the status strip.
 * @param live - false while it is down and the browser is retrying
 */
export function setStreamLive(live) {
  streamLive = live;
  document.getElementById('streamState').hidden = live;
  renderFollowLabel();
}

/**
 * Scrolls to the newest line and keeps the pane pinned there.
 */
function jumpToLatest() {
  el.logs.scrollTop = Math.max(0, visibleRecords.length * rowHeight - el.logs.clientHeight);
  schedulePaint();
}

/**
 * Recomputes which records pass the filters, then repaints the visible window.
 * @param options - `anchor` pins a specific line in place across the re-render
 */
export function renderLogs(options = {}) {
  const anchor = options.anchor === undefined ? currentAnchor() : options.anchor;
  visibleRecords = collapse(state.logs.filter(passesFilters));
  writeMetrics(el.logs.clientHeight);
  if (!state.follow) restoreAnchor(anchor);
  paintWindow();
}

/**
 * Writes the scrollbar's size, the counter, and the tail position when following.
 * @param viewport - the pane's height, already measured for this frame
 */
function writeMetrics(viewport) {
  el.spacer.style.height = `${visibleRecords.length * rowHeight}px`;
  el.count.textContent = `${visibleRecords.length.toLocaleString()} shown \u00B7 ${state.logs.length.toLocaleString()} buffered`;
  // A button that stays clickable when there is nothing behind it can silently
  // do nothing on click, which reads as broken rather than as "already empty".
  document.getElementById('purge').disabled = state.logs.length === 0;
  // Computed rather than read back as scrollHeight: reading the layout straight
  // after writing to it forces a synchronous reflow, and this used to run once
  // per arriving log line rather than once per frame.
  if (state.follow) el.logs.scrollTop = Math.max(0, visibleRecords.length * rowHeight - viewport);
}

/**
 * Renders just the slice of rows inside the viewport, offset into place.
 */
function paintWindow() {
  paintQueued = false;
  // The only layout read in the hot path, and it happens once per frame.
  const viewport = el.logs.clientHeight;
  if (metricsDirty) {
    metricsDirty = false;
    writeMetrics(viewport);
  }
  if (visibleRecords.length === 0) {
    el.window.style.transform = 'translateY(0)';
    el.window.innerHTML = emptyStateHtml();
    return;
  }
  const first = Math.max(0, Math.floor(el.logs.scrollTop / rowHeight) - OVERSCAN);
  const count = Math.ceil(viewport / rowHeight) + OVERSCAN * 2;
  const slice = visibleRecords.slice(first, first + count);
  el.window.style.transform = `translateY(${first * rowHeight}px)`;
  el.window.innerHTML = slice.map(rowHtml).join('');
}

/**
 * Coalesces repaints into one per animation frame.
 */
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(paintWindow);
}

/**
 * Explains an empty log pane, which is almost always a service helm-dev did not spawn.
 * @returns the empty-state HTML
 */
/**
 * Appends one newly arrived record, folding it into the last row when it repeats.
 * @param record - the log record
 */
/**
 * Brings the tab's buffer back inside the same budget the server keeps, in one
 * pass. Dropping a record per arriving line moves the whole array each time,
 * which measured at 121ms per 1000 lines once the buffer is full.
 */
function evictOldest() {
  if (state.bytes <= bufferBudgetBytes) return;
  const target = bufferBudgetBytes * 0.95;
  let dropped = 0;
  let freed = 0;
  while (dropped < state.logs.length - 1 && state.bytes - freed > target) {
    freed += state.logs[dropped].bytes ?? 256;
    dropped += 1;
  }
  if (dropped === 0) return;
  state.logs.splice(0, dropped);
  state.bytes -= freed;
}

/**
 * Empties the buffer entirely — server and this tab's own copy — as opposed to
 * "clear", which only moves the watermark and keeps every line reachable via
 * the divider's show. There is nothing to show after this.
 */
export function purgeLogs() {
  state.logs = [];
  state.bytes = 0;
  state.hiddenBelow = 0;
  state.selected = null;
  closeDetail();
  renderLogs();
  renderRestore();
}

export function appendLog(record) {
  state.logs.push(record);
  state.bytes += record.bytes ?? 256;
  evictOldest();
  if (!passesFilters(record)) return;
  const last = visibleRecords[visibleRecords.length - 1];
  if (last && !last.member && sameLine(last.record, record) && !state.expanded.has(last.groupId)) {
    last.records.push(record);
    last.repeat += 1;
    last.record = record;
  } else {
    visibleRecords.push({ record, records: [record], repeat: 1, groupId: record.seq });
  }
  metricsDirty = true;
  schedulePaint();
}

function emptyStateHtml() {
  // Focus keys are "repo/service"; split them back out to talk about them.
  const focused = [...state.focus].map((id) => {
    const slash = id.indexOf('/');
    return { repo: id.slice(0, slash), name: id.slice(slash + 1), id };
  });
  const stateOf = (service) => serviceState(service.repo, service.name);
  const label = (service) => (state.workspaces.length > 1 ? `${service.repo}/${service.name}` : service.name);
  const names = (list) => list.map(label).join(', ');

  const failed = focused.filter((service) => stateOf(service) === 'failed');
  if (failed.length > 0) {
    const reason = workspaceOf(failed[0].repo)?.statuses[failed[0].name]?.reason;
    return `<div class="empty">
      <p><strong>${escapeHtml(names(failed))}</strong> did not start.</p>
      ${reason ? `<p class="fail-reason">${escapeHtml(reason)}</p>` : ''}
      <p>Enable <strong>raw</strong> under <strong>Levels</strong> and switch off <strong>Hide noise</strong> to see the
      full build output, fix the cause, then press <strong>Restart</strong> on the service's row.</p>
    </div>`;
  }
  if (state.trace !== null) {
    return `<div class="empty"><p>No lines carry <strong>${escapeHtml(state.trace.key)}
      ${escapeHtml(state.trace.value)}</strong> in the buffer. Press <strong>Esc</strong> to drop the trace.</p></div>`;
  }

  const hidden = state.logs.filter((entry) => entry.seq <= state.hiddenBelow).length;
  if (hidden > 0) {
    const who = focused.length > 0 ? ` for <strong>${escapeHtml(names(focused))}</strong>` : '';
    return `<div class="empty"><p>Screen cleared${who}. <strong>${hidden}</strong> line(s) are still buffered —
      press <strong>show</strong> at the top to bring them back. New lines appear here as they arrive.</p></div>`;
  }

  const done = focused.filter((service) => stateOf(service) === 'completed');
  if (done.length > 0) {
    const ran = workspaceOf(done[0].repo)?.statuses[done[0].name]?.ranForMs;
    return `<div class="empty"><p><strong>${escapeHtml(names(done))}</strong> finished and exited cleanly${
      ran ? ` after ${formatDuration(ran)}` : ''
    }. Its output above is the whole run; press <strong>Start</strong> on its row to run it again.</p></div>`;
  }

  const externals = focused.filter((service) => workspaceOf(service.repo)?.external[service.name]);
  if (externals.length > 0) {
    return `<div class="empty">
      <p><strong>${escapeHtml(names(externals))}</strong> ${externals.length === 1 ? 'was' : 'were'} started outside
      helm-dev, so its output goes to that terminal — helm-dev cannot attach to a process it did not spawn.</p>
      <p>Two ways to get these logs here:</p>
      <ol>
        <li>Press <strong>Restart</strong> on the service's row to stop it and start it under helm-dev.</li>
        <li>Keep your terminal and tee into the drop dir:
          <code>npm start ${escapeHtml(externals[0].name)} 2&gt;&amp;1 | tee ${escapeHtml(state.tailDir ?? '/tmp/helm-dev-logs')}/${escapeHtml(externals[0].name)}.log</code></li>
      </ol>
    </div>`;
  }

  const booting = focused.filter((service) => stateOf(service) === 'starting');
  if (booting.length > 0) {
    return `<div class="empty"><p><strong>${escapeHtml(names(booting))}</strong> is still booting — the first lines
      appear as soon as the build finishes.</p></div>`;
  }

  const live = focused.filter((service) => stateOf(service) === 'running');
  if (live.length > 0) {
    return `<div class="empty"><p><strong>${escapeHtml(names(live))}</strong> is running and has not logged anything
      matching the current filters yet.</p></div>`;
  }
  if (focused.length > 0) {
    return `<div class="empty"><p>No logs yet for <strong>${escapeHtml(names(focused))}</strong>.
      Press <strong>Start</strong> on its row, or use <strong>Clear scope</strong>.</p></div>`;
  }
  return `<div class="empty"><p>No logs yet. Start a service with the play button on its row,
    or click a running one to focus just its output.</p></div>`;
}

/**
 * Expands or folds a run of repeated lines, keeping the run where it was on screen.
 * @param groupId - the sequence number that identifies the run
 * @param offset - how far below the pane's top the run's row sits
 */
function toggleGroup(groupId, offset) {
  const wasFollowing = state.follow;
  // Expanding inserts rows above the fold, so pin the run in place.
  if (state.expanded.has(groupId)) state.expanded.delete(groupId);
  else state.expanded.add(groupId);
  // Following would drag the view straight back to the bottom.
  state.follow = false;
  renderLogs({ anchor: { seq: groupId, offset } });
  setFollow(wasFollowing && state.expanded.size === 0);
}

el.logs.addEventListener('click', (event) => {
  const badge = event.target.closest('.repeat');
  if (badge) {
    const offset = badge.closest('.row').getBoundingClientRect().top - el.logs.getBoundingClientRect().top;
    toggleGroup(Number(badge.dataset.group), offset);
    return;
  }
  const row = event.target.closest('.row');
  if (!row) return;
  const record = state.logs.find((entry) => entry.seq === Number(row.dataset.seq));
  if (record) showDetail(record);
});

el.logs.addEventListener('scroll', schedulePaint, { passive: true });

// The pane's own size changes with the toolbar rows, the status strip, the
// inspector and the window, and a scrollbar appearing narrows it without any of
// those. One observer covers them all; the header borrows the scrollbar's width so
// its columns line up with the rows'.
new ResizeObserver(() => {
  el.logs.parentElement.style.setProperty('--scrollbar-w', `${el.logs.offsetWidth - el.logs.clientWidth}px`);
  metricsDirty = true;
  schedulePaint();
}).observe(el.logs);

// Following is decided by where you are, not by a switch: scroll up and it lets
// go, reach the bottom again and it resumes. The button only offers the way back.
el.logs.addEventListener(
  'scroll',
  () => {
    const atBottom = el.logs.scrollHeight - el.logs.scrollTop - el.logs.clientHeight < rowHeight * 2;
    if (atBottom === state.follow) return;
    setFollow(atBottom);
  },
  { passive: true },
);

// The list is one tab stop: rows are rebuilt on every paint, so none of them can
// hold focus. Arrow keys move the selection, which is what opens the inspector.
el.logs.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const at = visibleRecords.findIndex((row) => row.record.seq === state.selected);
  const page = Math.max(1, Math.floor(el.logs.clientHeight / rowHeight) - 1);
  const last = visibleRecords.length - 1;
  if (last < 0) return;
  // With nothing selected yet, the first move lands on the top line in view.
  const start = at === -1 ? Math.min(last, Math.ceil(el.logs.scrollTop / rowHeight)) : at;
  let target = null;
  if (event.key === 'ArrowDown') target = at === -1 ? start : at + 1;
  else if (event.key === 'ArrowUp') target = at === -1 ? start : at - 1;
  else if (event.key === 'PageDown') target = start + page;
  else if (event.key === 'PageUp') target = start - page;
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = last;
  else if (event.key === 'Enter' && at !== -1) target = at;
  else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && at !== -1) {
    const row = visibleRecords[at];
    const folded = row.repeat > 1;
    const open = row.member === true;
    if ((event.key === 'ArrowRight' && folded) || (event.key === 'ArrowLeft' && open)) {
      event.preventDefault();
      toggleGroup(row.groupId, at * rowHeight - el.logs.scrollTop);
    }
    return;
  }
  if (target === null) return;
  event.preventDefault();
  selectAt(Math.max(0, Math.min(last, target)));
});

document.getElementById('follow').addEventListener('click', () => {
  setFollow(true);
  jumpToLatest();
});

document.getElementById('purge').addEventListener('click', async (event) => {
  const count = state.logs.length;
  if (count === 0) return;
  if (!confirm(`Permanently free ${count.toLocaleString()} buffered log line(s)? This cannot be undone.`)) return;
  const button = event.target;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'clearing…';
  await post('/api/clear', {});
  // The server's broadcast does the actual reset, once it round-trips back over
  // SSE — which keeps this tab and any other open one in exact agreement rather
  // than each guessing the outcome locally. If the round trip is slow or the
  // connection drops, purge locally rather than leave the button stuck.
  if (state.logs.length > 0) purgeLogs();
  button.textContent = 'cleared ✓';
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
});

document.getElementById('clear').addEventListener('click', () => {
  // Clears the view only. The buffer is kept so the lines can be brought back.
  state.hiddenBelow = state.logs.length === 0 ? 0 : state.logs[state.logs.length - 1].seq;
  renderLogs();
  renderRestore();
});

/**
 * Shows or hides the divider that brings cleared lines back into view.
 */
export function renderRestore() {
  const bar = document.getElementById('restore');
  const hidden = state.logs.filter((entry) => entry.seq <= state.hiddenBelow).length;
  bar.hidden = hidden === 0;
  bar.textContent = `\u2014 ${hidden.toLocaleString()} earlier line${hidden === 1 ? '' : 's'} hidden \u00B7 show \u2014`;
}

document.getElementById('restore').addEventListener('click', () => {
  state.hiddenBelow = 0;
  renderLogs();
  renderRestore();
});

/**
 * Selects a row by position, scrolling it into view and opening its details.
 * @param index - the row's position in the visible list
 */
function selectAt(index) {
  const target = visibleRecords[index];
  if (!target) return;
  const top = el.logs.scrollTop;
  const bottom = top + el.logs.clientHeight;
  const y = index * rowHeight;
  if (y < top) el.logs.scrollTop = y;
  else if (y + rowHeight > bottom) el.logs.scrollTop = y + rowHeight - el.logs.clientHeight;
  schedulePaint();
  showDetail(target.record);
}

/**
 * Opens the line above or below the selected one, for the detail pane's arrows.
 * @param direction - 1 for the next line, -1 for the previous
 */
export function stepSelection(direction) {
  const at = visibleRecords.findIndex((row) => row.record.seq === state.selected);
  if (at === -1) return;
  selectAt(at + direction);
}

/**
 * Scrolls to the next or previous error/warning below or above the viewport.
 * @param direction - 1 to search forward, -1 to search back
 */
export function jumpToError(direction) {
  const current = Math.round(el.logs.scrollTop / rowHeight);
  const isProblem = (row) => row.record.level === 'error' || row.record.level === 'fatal';
  const range =
    direction > 0
      ? visibleRecords.slice(current + 1).findIndex(isProblem)
      : visibleRecords.slice(0, current).reverse().findIndex(isProblem);
  if (range === -1) return;
  const target = direction > 0 ? current + 1 + range : current - 1 - range;
  setFollow(false);
  el.logs.scrollTop = Math.max(0, target * rowHeight - el.logs.clientHeight / 3);
  schedulePaint();
}

