// Boot: load the state, paint it, subscribe to the stream, then hand over to the
// modules. Nothing here belongs in any one of them.

import { el, key, post, readPref, state, workspaceOf } from './core.js';
import { applyNoise, noiseButton, renderFocus } from './filters.js';
import { appendLog, jumpToError, purgeLogs, renderLogs, renderRestore, setBufferBudget } from './logs.js';
import { helpPanel, renderSettings, shortcutsOn } from './panels.js';
import { renderIndexMeta, renderPresets, renderServices, renderStats } from './services.js';
import { renderWorkspaceList } from './workspaces.js';

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

const events = new EventSource('/api/events');
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
  const typing = event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT';
  if (!shortcutsOn && event.key !== 'Escape') return;
  // Someone mid-selection is copying, not issuing commands.
  if (event.key !== 'Escape' && (window.getSelection()?.toString().length ?? 0) > 0) return;
  if (event.key === 'Escape') {
    if (state.trace !== null) {
      state.trace = null;
      renderFocus();
      renderLogs();
    } else {
      el.split.classList.remove('detail-open');
    }
    el.search.blur();
    return;
  }
  if (typing) return;
  if (event.key === '?') {
    helpPanel.hidden = !helpPanel.hidden;
  } else if (event.key === '/') {
    event.preventDefault();
    el.search.focus();
  } else if (event.key === 'e') {
    jumpToError(event.shiftKey ? -1 : 1);
  } else if (event.key === 'f') {
    document.getElementById('follow').click();
  } else if (event.key === 'n') {
    noiseButton.click();
  }
});

// Restore remembered filters so a reload does not throw away the current view.
state.showNoise = readPref('showNoise', false);
state.follow = readPref('follow', true);
document.getElementById('follow').classList.toggle('on', state.follow);
for (const level of readPref('hiddenLevels', [])) {
  state.levels.delete(level);
  document.querySelector(`.lvlFilter[data-level="${level}"]`)?.classList.remove('on');
}
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

