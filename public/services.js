// The sidebar: what is running, what could be, and the controls that change it.

import { el, escapeHtml, formatDuration, key, post, state, workspaceOf, writePref } from './core.js';
import { renderFocus } from './filters.js';
import { renderLogs } from './logs.js';

/**
 * Starts a service, showing anything the server flagged as risky first. The
 * checks exist because the expensive mistakes — swapping the machine, or binding
 * a port something else holds — are invisible until they have already happened.
 * @param name - the project name
 * @param options - `live` for a frontend dev server with live reload
 */
async function startService(repo, name, options = {}) {
  const result = await post('/api/start', { repo, name, ...options });
  if (!result.warnings) return;
  const text = result.warnings.map((warning) => `• ${warning.message}`).join('\n\n');
  if (!confirm(`Start ${name} (${repo}) anyway?\n\n${text}`)) return;
  await post('/api/start', { repo, name, ...options, force: true });
}

/**
 * Renders the service list with live status dots.
 */
export function serviceState(repo, name) {
  const workspace = workspaceOf(repo);
  if (!workspace) return 'stopped';
  const own = workspace.statuses[name]?.status;
  if (['running', 'starting', 'stopping', 'failed', 'completed'].includes(own)) return own;
  if (workspace.queued.includes(name)) return 'queued';
  if (workspace.external[name]) return 'external';
  return 'stopped';
}

const LIVE_ORDER = { failed: 0, running: 1, starting: 2, queued: 3, external: 4, stopping: 5, completed: 6, stopped: 7 };

// What counts as up and worth looking at. A failed service belongs here too: it
// is the one you most need to see, and it is not going to float up on its own.
const LIVE_STATES = ['running', 'starting', 'queued', 'external', 'failed'];

// The collapsed-state key for the running section. A workspace cannot be called
// this, so it cannot collide with one in the remembered preferences.
const RUNNING_SECTION = '@running';

/**
 * Applies the sidebar's text filter.
 * @param repo - the workspace name
 * @param name - the service name
 * @returns true when the row should be listed
 */
function matchesServiceFilter(repo, name) {
  const filter = state.serviceFilter.trim().toLowerCase();
  if (filter.length === 0) return true;
  return name.toLowerCase().includes(filter) || repo.toLowerCase().includes(filter);
}

/**
 * Every service that is up, across all workspaces, worst state first.
 * @returns the live services, each with the workspace it belongs to
 */
function liveEverywhere() {
  const rows = [];
  for (const workspace of state.workspaces) {
    for (const project of workspace.projects) {
      if (LIVE_STATES.includes(serviceState(workspace.name, project.name))) rows.push({ workspace, project });
    }
  }
  return rows.sort((a, b) => {
    const state_ = (row) => LIVE_ORDER[serviceState(row.workspace.name, row.project.name)];
    return (
      state_(a) - state_(b) ||
      a.workspace.name.localeCompare(b.workspace.name) ||
      a.project.name.localeCompare(b.project.name)
    );
  });
}

/**
 * Orders one workspace's projects: anything alive first, then by kind, then name.
 * @param workspace - the workspace record
 * @returns its projects in display order
 */
function orderedProjects(workspace) {
  const pinnedRank = (name) => (state.pinned.has(key(workspace.name, name)) ? 0 : 1);
  return [...workspace.projects].sort((a, b) => {
    const pinned = pinnedRank(a.name) - pinnedRank(b.name);
    if (pinned !== 0) return pinned;
    const rank = LIVE_ORDER[serviceState(workspace.name, a.name)] - LIVE_ORDER[serviceState(workspace.name, b.name)];
    if (rank !== 0) return rank;
    const kinds = { app: 0, job: 1, frontend: 2, other: 3 };
    return kinds[a.kind] - kinds[b.kind] || a.name.localeCompare(b.name);
  });
}

/**
 * Lists every service currently alive, across all workspaces.
 * @returns records of { repo, name }
 */
function liveServices() {
  const live = [];
  for (const workspace of state.workspaces) {
    for (const project of workspace.projects) {
      if (['running', 'starting', 'queued', 'external', 'failed'].includes(serviceState(workspace.name, project.name))) {
        live.push({ repo: workspace.name, name: project.name });
      }
    }
  }
  return live;
}

/**
 * Enables the stop-all control only when something is actually running.
 */
function renderStopAll() {
  const count = liveServices().length;
  const button = document.getElementById('stopAll');
  button.disabled = count === 0;
  button.textContent = count === 0 ? 'stop all' : `stop all (${count})`;
}

/**
 * Renders one service row.
 * @param workspace - the workspace it belongs to
 * @param project - the project record
 * @returns the row HTML
 */
function serviceRowHtml(workspace, project, options = {}) {
  const repo = workspace.name;
  const id = key(repo, project.name);
  const status = serviceState(repo, project.name);
  const live = ['running', 'external', 'starting', 'queued', 'failed'].includes(status);
  const entry = workspace.statuses[project.name] ?? {};
  const unconfirmed = status === 'running' && entry.confirmed === false;
  const muted = workspace.muted.includes(project.name);
  // Angular's dev server reloads itself; helm-dev neither watches nor restarts it.
  const isFrontend = project.kind === 'frontend';
  const mode = entry.mode ?? 'plain';
  const failure = status === 'failed' ? entry.reason : null;
  const focused = state.focus.has(id);
  const stale = live && workspace.staleness[project.name]?.stale === true;
  const changed = workspace.staleness[project.name]?.changed?.length ?? 0;
  const memory = state.stats.services?.[`${repo}::${project.name}`];

  const notes = [`${repo}: ${project.root}`];
  if (status === 'external') notes.push('started outside helm-dev — logs only via tail file');
  if (stale) notes.push(`${changed} file(s) changed since it started`);
  if (status === 'starting') notes.push('still booting — logs stream as it comes up');
  if (status === 'queued') notes.push('waiting to start — services boot a few at a time');
  if (failure) notes.push(`did not boot: ${failure}`);
  if (status === 'completed') notes.push('finished its work and exited cleanly — press ▶ to run it again');
  if (isFrontend) {
    notes.push(
      mode === 'live'
        ? 'live reload on: rebuilds and refreshes on change'
        : 'started without live reload — use ▶L if you want it',
    );
  }
  if (unconfirmed) notes.push('no boot signal seen — assumed up after 60s');
  if (muted) notes.push('logs muted — click the muted badge to enable');
  notes.push(live ? 'click to show only this service' : 'click ▶ to start');

  return `<div class="service ${stale ? 'stale' : ''} ${focused ? 'focused' : ''} ${state.pinned.has(id) ? 'pinned' : ''}"
      data-repo="${escapeHtml(repo)}" data-name="${escapeHtml(project.name)}" title="${escapeHtml(notes.join('\n'))}">
    <span class="dot ${status}"></span>
    ${options.showRepo === true ? `<span class="svc-repo">${escapeHtml(repo)}</span>` : ''}
    <span class="name">${escapeHtml(project.name)}</span>
    ${stale ? `<span class="badge stale-badge">${changed}&#916;</span>` : ''}
    ${status === 'queued' ? `<span class="badge queued-badge">queued ${workspace.queued.indexOf(project.name) + 1}</span>` : ''}
    ${status === 'failed' ? '<span class="badge failed-badge">boot failed</span>' : ''}
    ${status === 'completed' ? `<span class="badge done-badge">done${entry.ranForMs ? ` ${formatDuration(entry.ranForMs)}` : ''}</span>` : ''}
    ${live && mode === 'live' ? '<span class="badge live-badge" title="started with live reload">live</span>' : ''}
    ${unconfirmed ? '<span class="badge queued-badge">unconfirmed</span>' : ''}
    ${muted ? '<span class="badge muted-badge" data-act="unmute" title="logs are off for this service — click to turn them on">muted</span>' : ''}
    ${memory ? `<span class="mem">${memory}M</span>` : ''}
    <span class="actions">
      <button class="mini pin ${state.pinned.has(id) ? 'on' : ''}" data-act="pin"
        title="${state.pinned.has(id) ? 'unpin — stop keeping it at the top' : 'pin — keep it at the top of this workspace'}"
        >${state.pinned.has(id) ? '&#9733;' : '&#9734;'}</button>
      ${live ? '<button class="mini" data-act="restart" title="stop and start again">&#10227;</button>' : ''}
      ${live ? '<button class="mini" data-act="stop" title="stop service">&times;</button>' : '<button class="mini" data-act="start" title="start service">&#9654;</button>'}
      ${!live && isFrontend
        ? '<button class="mini watch-start" data-act="live" title="start with live reload — rebuilds on change, but uses far more memory">&#9654;L</button>'
        : ''}
    </span>
  </div>`;
}

/**
 * Decides which services a section shows: all of them, narrowed by the filter.
 * @param workspace - the workspace record
 * @returns the projects to render
 */
function visibleProjects(workspace) {
  return orderedProjects(workspace).filter((project) => matchesServiceFilter(workspace.name, project.name));
}

/**
 * Renders every workspace as its own section, so the same service name in two
 * repositories is never confused for one.
 */
export function renderServices() {
  renderStopAll();
  const filtering = state.serviceFilter.trim().length > 0;

  // With one workspace the live-first ordering already puts these at the top, so
  // a second section would cost a header and say nothing new. With several, what
  // is actually up is scattered across sections a screenful apart — so it is
  // lifted out and listed once, here, rather than duplicated.
  const lifted = state.workspaces.length > 1 ? liveEverywhere() : [];
  const liftedKeys = new Set(lifted.map(({ workspace, project }) => key(workspace.name, project.name)));
  const running = lifted.filter(({ workspace, project }) => matchesServiceFilter(workspace.name, project.name));
  const runningCollapsed = state.collapsed.has(RUNNING_SECTION) && !filtering;

  const runningSection =
    running.length === 0
      ? ''
      : `<div class="live-section ${runningCollapsed ? 'collapsed' : ''}">
        <div class="repo-head" data-repo-head="${RUNNING_SECTION}"
          title="every service that is up, in every workspace">
          <span class="repo-caret">${runningCollapsed ? '&#9656;' : '&#9662;'}</span>
          <span class="repo-name">running</span>
          <span class="repo-live">${running.length}</span>
        </div>
        ${runningCollapsed ? '' : running.map(({ workspace, project }) => serviceRowHtml(workspace, project, { showRepo: true })).join('')}
      </div>`;

  const sections = state.workspaces.map((workspace) => {
    const collapsed = state.collapsed.has(workspace.name) && !filtering;
    const liveHere = workspace.projects.filter((project) =>
      ['running', 'starting', 'queued', 'external', 'failed'].includes(serviceState(workspace.name, project.name)),
    ).length;
    const git = state.stats.git?.[workspace.name];
    const shown = visibleProjects(workspace).filter((project) => !liftedKeys.has(key(workspace.name, project.name)));
    if (filtering && shown.length === 0) return '';
    const rows = collapsed ? '' : shown.map((project) => serviceRowHtml(workspace, project)).join('');

    return `<div class="repo-section ${collapsed ? 'collapsed' : ''}" draggable="true"
      data-repo="${escapeHtml(workspace.name)}">
      <div class="repo-head" data-repo-head="${escapeHtml(workspace.name)}" title="${escapeHtml(workspace.root)}">
        <span class="repo-caret">${collapsed ? '&#9656;' : '&#9662;'}</span>
        <span class="repo-name">${escapeHtml(workspace.name)}</span>
        ${liveHere > 0
          ? `<span class="repo-live" title="${lifted.length > 0 ? 'listed under running, above' : 'up right now'}">${liveHere} up</span>`
          : ''}
        ${liveHere > 0
          ? `<button class="mini repo-stop" data-stop-repo="${escapeHtml(workspace.name)}"
              title="stop the ${liveHere} running service(s) in ${escapeHtml(workspace.name)}">&times;</button>`
          : ''}
      </div>
      ${git ? `<div class="repo-branch" title="${escapeHtml(git.branch)}">${escapeHtml(git.branch)}</div>` : ''}
      ${rows}
    </div>`;
  });

  el.services.innerHTML =
    runningSection + sections.join('') || '<div class="no-match">nothing matches that filter</div>';
}

/**
 * Renders the saved presets plus the control to save the running set as a new one.
 */
export function renderPresets() {
  const saved = Object.keys(state.presets)
    .map(
      (name) => `<span class="preset">
        <button data-preset="${escapeHtml(name)}" title="start the services in this preset">${escapeHtml(name)}</button>
        <button class="preset-del" data-del="${escapeHtml(name)}" title="delete this preset">&times;</button>
      </span>`,
    )
    .join('');
  el.presets.innerHTML = `${saved}<button id="savePreset">+ save running</button>`;
}

el.services.addEventListener('click', async (event) => {
  const stopRepo = event.target.closest('.repo-stop');
  if (stopRepo) {
    const repo = stopRepo.dataset.stopRepo;
    const live = liveServices().filter((service) => service.repo === repo);
    if (live.length === 0) return;
    if (!confirm(`Stop ${live.length} service(s) in ${repo}?\n\n${live.map((s2) => s2.name).join(', ')}`)) return;
    stopRepo.textContent = '…';
    await post('/api/stop-all', { repo });
    renderServices();
    return;
  }

  const head = event.target.closest('.repo-head');
  if (head) {
    const repo = head.dataset.repoHead;
    if (state.collapsed.has(repo)) state.collapsed.delete(repo);
    else state.collapsed.add(repo);
    writePref('collapsed', [...state.collapsed]);
    renderServices();
    return;
  }

  const node = event.target.closest('.service');
  if (!node) return;
  const repo = node.dataset.repo;
  const name = node.dataset.name;
  const id = key(repo, name);
  const action = event.target.dataset?.act;

  if (action === 'restart') {
    if (!confirm(`Restart ${name} (${repo})? The running process will be stopped first.`)) return;
    renderServices();
    await post('/api/restart', { repo, name });
    return;
  }
  if (action === 'stop') {
    await post('/api/stop', { repo, name });
    state.focus.delete(id);
    renderServices();
    renderFocus();
    renderLogs();
    return;
  }
  if (action === 'pin') {
    if (state.pinned.has(id)) state.pinned.delete(id);
    else state.pinned.add(id);
    writePref('pinned', [...state.pinned]);
    renderServices();
    return;
  }
  if (action === 'unmute') {
    await post('/api/mute', { repo, name, muted: false });
    renderServices();
    return;
  }
  if (action === 'live' || action === 'start') {
    state.focus.add(id);
    await startService(repo, name, { live: action === 'live' });
    renderServices();
    renderFocus();
    renderLogs();
    return;
  }

  // A plain click on the row focuses that service's logs; it never stops anything.
  if (state.focus.has(id)) state.focus.delete(id);
  else state.focus.add(id);
  renderServices();
  renderFocus();
  renderLogs();
  writePref('focus', [...state.focus]);
});

/**
 * Renders the repository and footprint readout in the header.
 */
export function renderStats() {
  const { git, selfMB, services } = state.stats;
  const running = Object.keys(services ?? {}).length;
  const serviceTotal = Object.values(services ?? {}).reduce((sum, mb) => sum + mb, 0);

  const names = state.workspaces.map((workspace) => workspace.name);
  document.getElementById('repoName').textContent = names.join(' · ');

  // With one workspace the branch belongs in the header; with several it belongs
  // next to each section, where it already is.
  const branch = document.getElementById('branchName');
  const only = names.length === 1 ? git?.[names[0]] : null;
  branch.innerHTML = only ? `<span class="glyph">&#9095;</span>${escapeHtml(only.branch)}` : '';
  branch.title = only ? `current branch — ${only.branch}` : '';

  const bits = [];
  if (only) {
    bits.push(`<span title="modified tracked files">${only.modified} modified</span>`);
    bits.push(`<span title="untracked files">${only.untracked} untracked</span>`);
  }
  if (running > 0) bits.push(`<span title="services running / their total memory">${running} up &middot; ${serviceTotal}MB</span>`);
  if (state.stats.availableMB) {
    bits.push(`<span title="memory available on this machine">${(state.stats.availableMB / 1000).toFixed(1)}GB free</span>`);
  }
  if (state.stats.bufferMaxMB) {
    bits.push(
      `<span title="log buffer — oldest lines are dropped once full">buffer ${state.stats.bufferMB}/${state.stats.bufferMaxMB}MB</span>`,
    );
  }
  if (selfMB) bits.push(`<span title="helm-dev's own memory">helm-dev ${selfMB}MB</span>`);
  document.getElementById('statsBar').innerHTML = bits.join('<span class="sep">|</span>');
}

el.presets.addEventListener('click', async (event) => {
  if (event.target.id === 'savePreset') {
    const running = liveServices();
    if (running.length === 0) return;
    const name = prompt('Preset name', 'my-setup');
    if (!name) return;
    state.presets[name] = running;
    await post('/api/presets', state.presets);
    renderPresets();
    return;
  }
  const doomed = event.target.dataset.del;
  if (doomed) {
    if (!confirm(`Delete the preset "${doomed}"? The services it lists are not touched.`)) return;
    delete state.presets[doomed];
    await post('/api/presets', state.presets);
    renderPresets();
    return;
  }
  const preset = event.target.dataset.preset;
  if (preset) {
    for (const entry of state.presets[preset]) {
      // Older presets stored bare names, from before workspaces existed.
      const service = typeof entry === 'string' ? { repo: state.workspaces[0]?.name, name: entry } : entry;
      await startService(service.repo, service.name);
    }
  }
});

/**
 * Shows how many log sites are indexed, reading the workspaces rather than any
 * one response, so boot and a reindex cannot word it differently.
 */
export function renderIndexMeta() {
  const total = state.workspaces.reduce((sum, workspace) => sum + (workspace.index?.sites ?? 0), 0);
  const across = state.workspaces.length > 1 ? ` across ${state.workspaces.length} workspaces` : '';
  el.indexMeta.textContent = `${total.toLocaleString()} log sites indexed${across}`;
}

document.getElementById('reindex').addEventListener('click', async (event) => {
  event.target.textContent = 'indexing…';
  // One entry per workspace, keyed by name — there is no single index to read.
  const meta = await post('/api/reindex');
  for (const workspace of state.workspaces) {
    if (meta[workspace.name]) workspace.index = meta[workspace.name];
  }
  renderIndexMeta();
  event.target.textContent = 'reindex';
});

el.services.addEventListener('click', () => writePref('focus', [...state.focus]));

document.getElementById('stopAll').addEventListener('click', async (event) => {
  const live = liveServices();
  if (live.length === 0) return;
  const listed = live.map((service) => `${service.repo}/${service.name}`).join(', ');
  if (!confirm(`Stop ${live.length} service(s)?\n\n${listed}`)) return;
  event.target.textContent = 'stopping…';
  await post('/api/stop-all');
  renderServices();
});

const serviceFilter = document.getElementById('serviceFilter');
let filterTimer = null;

serviceFilter.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    state.serviceFilter = serviceFilter.value;
    renderServices();
  }, 90);
});

serviceFilter.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  serviceFilter.value = '';
  state.serviceFilter = '';
  renderServices();
  serviceFilter.blur();
});
