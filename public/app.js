// Boot: load the state, paint it, subscribe to the stream, then hand over to the
// modules. Nothing here belongs in any one of them.

import { el, key, post, readPref, state, workspaceOf } from './core.js';
import { applyNoise, noiseButton, renderFocus, renderLevels } from './filters.js';
import { closeDetail } from './detail.js';
import { appendLog, jumpToError, purgeLogs, renderLogs, renderRestore, setBufferBudget, setStreamLive } from './logs.js';
import { helpPanel, renderSettings, shortcutsOn, togglePanel } from './panels.js';
import { renderIndexMeta, renderPresets, renderServices, renderStats } from './services.js';
import { renderWorkspaceList } from './workspaces.js';
import './report.js';

// Theme and the draggable dividers are all side effects, so nothing imports a
// name from here — without this line the module would simply never load.
import './layout.js';

const initial = await (await fetch('/api/state')).json();

if (initial.needsRepo) {
  const panel = document.getElementById('firstRun');
  const error = document.getElementById('repoError');
  const pathInput = document.getElementById('repoPath');
  panel.hidden = false;
  pathInput.focus();

  const submit = async () => {
    error.textContent = '';
    const path = pathInput.value.trim();
    if (path.length === 0) return;
    const result = await post('/api/repos', { path, name: document.getElementById('repoLabel').value });
    if (result.error) {
      error.textContent = result.error;
      return;
    }
    window.location.reload();
  };
  document.getElementById('repoSave').addEventListener('click', submit);
  for (const input of [pathInput, document.getElementById('repoLabel')]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }
}
state.workspaces = initial.workspaces ?? [];
state.presets = initial.presets;
state.stats = initial.stats ?? { services: {}, git: {} };
state.home = initial.home ?? '';
if (state.stats.bufferMaxMB) setBufferBudget(state.stats.bufferMaxMB);
document.getElementById('version').textContent = initial.version ? ` v${initial.version}` : '';
renderIndexMeta();
renderServices();
renderPresets();
renderFocus();
renderRestore();
renderStats();

state.logs = await (await fetch('/api/logs?limit=3000')).json();
renderLogs();

/**
 * Reloads what the page may have missed while its event stream was down. The
 * browser reconnects an EventSource silently, but nothing replays the events in
 * between — a service that came up meanwhile stayed "starting" until a refresh.
 */
async function resync() {
  const fresh = await (await fetch('/api/state')).json();
  state.workspaces = fresh.workspaces ?? [];
  state.stats = fresh.stats ?? state.stats;
  renderIndexMeta();
  renderServices();
  renderStats();

  const missed = await (await fetch('/api/logs?limit=3000')).json();
  const lastSeen = state.logs[state.logs.length - 1]?.seq ?? 0;
  // A sequence that went backwards means the server restarted: its counter began
  // again, so nothing the page holds can be matched against it.
  if (missed.length > 0 && missed[missed.length - 1].seq < lastSeen) {
    state.logs = missed;
    renderLogs();
    return;
  }
  for (const record of missed) {
    if (record.seq > lastSeen) appendLog(record);
  }
}

const events = new EventSource('/api/events');
let streamOpened = false;
// EventSource retries on its own; the page's part is to say it is not live meanwhile.
events.onerror = () => setStreamLive(false);
events.onopen = () => {
  setStreamLive(true);
  // The first open is the boot itself; only a later one is a reconnect.
  if (!streamOpened) {
    streamOpened = true;
    return;
  }
  resync().catch(() => undefined);
};
events.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.type === 'log') {
    // The frame's own length is the record's footprint. The server measures the
    // same way, so both buffers evict at the same point.
    event.bytes = message.data.length;
    appendLog(event);
  }
  if (event.type === 'status') {
    const workspace = workspaceOf(event.repo);
    if (workspace) {
      if (event.status === 'queued') {
        if (!workspace.queued.includes(event.service)) workspace.queued.push(event.service);
      } else {
        workspace.queued = workspace.queued.filter((name) => name !== event.service);
        workspace.statuses[event.service] = {
          status: event.status,
          pid: event.pid ?? null,
          confirmed: event.confirmed,
          ports: event.ports ?? [],
          reason: event.reason,
          mode: event.mode ?? workspace.statuses[event.service]?.mode,
          ranForMs: event.ranForMs,
        };
      }
      if (event.status === 'failed') {
        state.focus.add(key(event.repo, event.service));
        renderFocus();
        renderLogs();
      }
    }
    renderServices();
    return;
  }
  if (event.type === 'external') {
    for (const workspace of state.workspaces) workspace.external = event.workspaces[workspace.name] ?? {};
    renderServices();
  }
  if (event.type === 'settings') {
    renderSettings(event.settings);
  }
  if (event.type === 'stats') {
    state.stats = event.stats;
    renderStats();
    renderServices();
  }
  if (event.type === 'stale') {
    const workspace = workspaceOf(event.repo);
    if (workspace) workspace.staleness[event.service] = { stale: true, changed: event.changed };
    renderServices();
  }
};

document.addEventListener('keydown', (event) => {
  // Never hijack a browser shortcut: Ctrl+C is copy, not "clear".
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // Fields, and anything inside a menu, are for typing or choosing — never shortcuts.
  const typing =
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) ||
    event.target.isContentEditable === true ||
    event.target.closest?.('[role="menu"]') != null;
  if (!shortcutsOn && event.key !== 'Escape') return;
  // Someone mid-selection is copying, not issuing commands.
  if (event.key !== 'Escape' && (window.getSelection()?.toString().length ?? 0) > 0) return;
  if (event.key === 'Escape') {
    // A floating inspector is a dialog, and a dialog closes on Escape.
    const floating = el.split.classList.contains('detail-open') && el.split.dataset.inspector === 'overlay';
    if (state.trace !== null && !floating) {
      state.trace = null;
      renderFocus();
      renderLogs();
    } else {
      closeDetail();
    }
    el.search.blur();
    return;
  }
  if (typing) return;
  if (event.key === '?') {
    togglePanel(helpPanel);
  } else if (event.key === '/') {
    event.preventDefault();
    el.search.focus();
  } else if (event.key === 'e') {
    jumpToError(event.shiftKey ? -1 : 1);
  } else if (event.key === 'n') {
    noiseButton.click();
  }
});

// Restore remembered filters so a reload does not throw away the current view.
state.showNoise = readPref('showNoise', false);
for (const level of readPref('hiddenLevels', [])) {
  state.levels.delete(level);
}
renderLevels();
// Focus keys became "repo/service" when workspaces arrived; anything stored in
// the old shape can no longer match, so it is dropped rather than silently
// filtering every line away.
for (const id of readPref('focus', [])) {
  if (typeof id === 'string' && id.includes('/')) state.focus.add(id);
}
renderFocus();
renderLogs();

applyNoise();
renderFocus();
renderServices();

renderSettings(initial.settings);

for (const repo of readPref('collapsed', [])) state.collapsed.add(repo);
for (const id of readPref('pinned', [])) state.pinned.add(id);
renderServices();

renderWorkspaceList();

