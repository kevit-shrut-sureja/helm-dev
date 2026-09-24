import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { killExternal } from './lib/detect.mjs';
import { Workspace } from './lib/workspace.mjs';
import { gitStatus, serviceMemory } from './lib/stats.mjs';
import { availableMemoryMB, preflight } from './lib/preflight.mjs';
import { LogTailer } from './lib/tailer.mjs';
import { loadSettings, saveSettings } from './lib/settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// package.json is the single source of the version; the UI and the banner read it.
const VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;

/**
 * Confirms a path is an Nx workspace helm-dev can work with.
 * @param candidate - the path to check
 * @returns the absolute path, or null when it is not a workspace
 */
function asWorkspace(candidate) {
  if (!candidate) return null;
  const absolute = resolvePath(candidate.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  return existsSync(join(absolute, 'nx.json')) ? absolute : null;
}

/**
 * Finds a workspace by walking up from the current directory, for the case where
 * helm-dev is run from inside one.
 * @returns the absolute repo root, or null
 */
function workspaceAboveCwd() {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, 'nx.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}
const PRESETS_PATH = join(HERE, '.cache', 'presets.json');
const SESSION_PATH = join(HERE, '.cache', 'session.json');
const SETTINGS_PATH = join(HERE, 'settings.json');
const PORT = Number(process.env.HELMDEV_PORT ?? 7788);
// Whatever the OS calls its temp directory, and per-user so two people on one
// box do not tail each other's files.
const TAIL_DIR = process.env.HELMDEV_TAIL_DIR ?? join(tmpdir(), `helm-dev-logs-${userInfo().username}`);
// Any editor, not just VSCode: {file} and {line} are substituted.
const EDITOR_CMD = process.env.HELMDEV_EDITOR ?? 'code -g {file}:{line}';
let bufferBudget = 50 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8192;
const DETECT_INTERVAL_MS = Number(process.env.HELMDEV_DETECT_MS ?? 8000);
// Documented as an override and used for testing eviction, so it wins over the
// stored setting for the life of the process.
const BUFFER_OVERRIDE_MB = Number(process.env.HELMDEV_BUFFER_MB) || null;

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

const buffer = [];
let bufferBytes = 0;
const clients = new Set();
let sequence = 0;

await mkdir(join(HERE, '.cache'), { recursive: true });
let settings = await loadSettings(SETTINGS_PATH);
const workspaces = new Map();
const tailer = new LogTailer(TAIL_DIR);
let stats = { services: {}, git: null, selfMB: 0 };

/**
 * Adds a workspace and starts watching it. Several can be open at once: a
 * developer may be working in one repository while running a single service
 * from another.
 * @param name - the label for this workspace
 * @param root - absolute path to it
 * @returns the workspace
 */
async function addWorkspace(name, root) {
  const existing = workspaces.get(name);
  if (existing) return existing;

  const workspace = new Workspace(name, root, join(HERE, '.cache'));
  await workspace.init({ reindex: process.argv.includes('--reindex') });
  workspace.on('log', (record) => broadcast('log', record));
  workspace.on('status', (status) => broadcast('status', status));
  workspace.on('stale', (event) => broadcast('stale', event));
  workspaces.set(name, workspace);
  applySettings();
  return workspace;
}

/**
 * Resolves the workspace a request is talking about.
 * @param repo - the workspace name, or undefined when only one is open
 * @returns the workspace, or null
 */
function workspaceFor(repo) {
  if (repo) return workspaces.get(repo) ?? null;
  return workspaces.size === 1 ? [...workspaces.values()][0] : null;
}

/**
 * Applies machine-level settings to the pieces that enforce them.
 */
function applySettings() {
  // The buffer budget applies with or without a workspace; the rest needs one.
  bufferBudget = Math.max(1, BUFFER_OVERRIDE_MB ?? settings.bufferMB) * 1024 * 1024;
  while (bufferBytes > bufferBudget && buffer.length > 1) {
    bufferBytes -= buffer.shift().bytes;
  }
  for (const workspace of workspaces.values()) {
    workspace.runner.setConcurrency(settings.resolvedConcurrency);
    // Angular build output is voluminous and rarely what anyone is debugging.
    for (const project of workspace.projects.filter((candidate) => candidate.kind === 'frontend')) {
      workspace.runner.setMuted(project.name, settings.muteFrontends);
    }
  }
}

applySettings();

/**
 * Caps one record's payload, so a single huge dump cannot evict the whole buffer.
 * @param record - the log record, modified in place
 */
function capPayload(record) {
  if (typeof record.fields?.detail !== 'string' || record.fields.detail.length <= MAX_PAYLOAD_BYTES) return;
  const kept = record.fields.detail.slice(0, MAX_PAYLOAD_BYTES);
  record.fields = { ...record.fields, detail: `${kept}\n… truncated, payload exceeded ${MAX_PAYLOAD_BYTES} bytes` };
}

// Dropping one record per arriving line moves the whole array every time, which
// measured at 121ms per 1000 lines on a full buffer. Evicting down to a low-water
// mark instead makes that one array move every few thousand lines.
const BUFFER_LOW_WATER = 0.95;

/**
 * Brings the buffer back inside its budget, in one pass rather than per line.
 */
function evictOldest() {
  if (bufferBytes <= bufferBudget) return;
  const target = bufferBudget * BUFFER_LOW_WATER;
  let dropped = 0;
  let freed = 0;
  while (dropped < buffer.length - 1 && bufferBytes - freed > target) {
    freed += buffer[dropped].bytes;
    dropped += 1;
  }
  if (dropped === 0) return;
  buffer.splice(0, dropped);
  bufferBytes -= freed;
}

// Log lines arrive in bursts of hundreds; a write per line is a syscall per line.
// Status events are what the UI reacts to, so those still go out at once — and
// take any waiting log lines with them, which keeps the order intact.
const FLUSH_MS = 16;
const pendingFrames = [];
let flushTimer = null;

/**
 * Writes everything waiting to every connected browser.
 */
function flushFrames() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingFrames.length === 0) return;
  const payload = pendingFrames.join('');
  pendingFrames.length = 0;
  for (const client of clients) client.write(payload);
}

/**
 * Appends a record to the ring buffer and pushes it to every connected browser.
 * @param type - the event type, log or status
 * @param payload - the event body
 */
function broadcast(type, payload) {
  sequence += 1;
  const event = { type, seq: sequence, ...payload };
  if (type === 'log') capPayload(event);

  const frame = `data: ${JSON.stringify(event)}\n\n`;
  if (type === 'log') {
    // The frame is the record's real footprint, and it has just been measured by
    // serialising it — so nothing is serialised twice to find out.
    event.bytes = frame.length;
    buffer.push(event);
    bufferBytes += event.bytes;
    evictOldest();
  }

  pendingFrames.push(frame);
  if (type !== 'log') {
    flushFrames();
    return;
  }
  if (flushTimer === null) flushTimer = setTimeout(flushFrames, FLUSH_MS);
}

tailer.on('log', (record) => {
  // A tailed file is named after the service, not the workspace. Attribute it
  // when exactly one open workspace has a project by that name.
  const owners = [...workspaces.values()].filter((workspace) => workspace.projectNames.has(record.service));
  broadcast('log', owners.length === 1 ? { ...record, repo: owners[0].name } : record);
});

/**
 * Starts a service in its workspace, choosing the flags its stack needs.
 * @param workspace - the workspace it belongs to
 * @param name - the project name
 * @param options - `live` for a frontend dev server with live reload
 * @returns whether it was queued
 */
function startService(workspace, name, options = {}) {
  // Only an Angular dev server can reload itself, and doing so costs gigabytes,
  // so a plain start switches watching and reloading off explicitly. Backends
  // are always started plain — they have no equivalent.
  const kind = workspace.project(name)?.kind ?? 'app';
  const live = kind === 'frontend' && options.live === true;
  const args = kind === 'frontend' && !live ? ['--watch=false', '--liveReload=false'] : [];
  return workspace.runner.enqueue(name, { args, mode: live ? 'live' : 'plain', kind });
}

/**
 * Re-scans every workspace for services started outside helm-dev.
 */
async function refreshExternal() {
  let changed = false;
  for (const workspace of workspaces.values()) {
    const before = new Set(Object.keys(workspace.external));
    if (await workspace.refreshExternal()) {
      changed = true;
      for (const name of Object.keys(workspace.external)) {
        if (!before.has(name)) await workspace.watchSources(name);
      }
    }
  }
  if (changed) broadcast('external', { workspaces: externalByWorkspace() });
}

/**
 * Collects the externally started services of every workspace.
 * @returns a map of workspace name to its external services
 */
function externalByWorkspace() {
  const out = {};
  for (const [name, workspace] of workspaces) out[name] = workspace.external;
  return out;
}

/**
 * Recomputes per-service memory and each workspace's git state.
 */
async function refreshStats() {
  const roots = {};
  for (const [repo, workspace] of workspaces) {
    for (const [name, entry] of Object.entries(workspace.runner.statuses())) {
      if (entry.pid !== null && entry.status !== 'stopped') roots[`${repo}::${name}`] = entry.pid;
    }
    for (const [name, entry] of Object.entries(workspace.external)) roots[`${repo}::${name}`] = entry.pid;
  }

  const services = await serviceMemory(roots);
  const git = {};
  let watches = 0;
  for (const [repo, workspace] of workspaces) {
    git[repo] = await gitStatus(workspace.root);
    watches += workspace.watcher.watchCount();
  }

  stats = {
    services,
    git,
    selfMB: Math.round(process.memoryUsage().rss / 1048576),
    availableMB: await availableMemoryMB(),
    watches,
    buffered: buffer.length,
    bufferMB: Math.round((bufferBytes / 1048576) * 10) / 10,
    bufferMaxMB: BUFFER_OVERRIDE_MB ?? settings.bufferMB,
    concurrency: settings.resolvedConcurrency,
  };
  broadcast('stats', { stats });
}

// Open every registered workspace. A developer may be working in one repository
// and running a single service from another at the same time.
const registered = [...settings.repos];
const fromEnv = asWorkspace(process.env.HELMDEV_REPO) ?? workspaceAboveCwd();
if (fromEnv !== null && !registered.some((repo) => repo.path === fromEnv)) {
  registered.push({ name: fromEnv.split('/').filter(Boolean).pop(), path: fromEnv });
  settings = await saveSettings(SETTINGS_PATH, settings, { repos: registered });
}

for (const repo of registered) {
  const root = asWorkspace(repo.path);
  if (root === null) {
    process.stderr.write(`skipping "${repo.name}": ${repo.path} is no longer an Nx workspace\n`);
    continue;
  }
  await addWorkspace(repo.name, root);
}

if (workspaces.size > 0) {
  await refreshExternal();
  await refreshStats();
}

setInterval(() => {
  if (workspaces.size === 0) return;
  refreshExternal()
    .then(() => refreshStats())
    .catch(() => undefined);
}, DETECT_INTERVAL_MS);

// Booting is checked far more often than the rest: a service that is up but
// still labelled "starting" is the difference between waiting and working.
setInterval(() => {
  for (const workspace of workspaces.values()) workspace.confirmBooting().catch(() => undefined);
}, 2000);

/**
 * Rejects paths that escape the monorepo, since the UI can ask to open arbitrary
 * files. Paths arrive repo-relative, so with several workspaces open the same
 * path resolves under every one of them: the record's own repo is tried first,
 * and another workspace is only accepted when the file is really there.
 * @param relativePath - a repo-relative path from the client
 * @param repo - the workspace the client attributed the path to
 * @returns the absolute path, or null when it is outside every workspace
 */
function safeRepoPath(relativePath, repo) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  const preferred = workspaceFor(repo);
  for (const workspace of preferred ? [preferred, ...workspaces.values()] : workspaces.values()) {
    const absolute = resolvePath(workspace.root, relativePath);
    if (absolute.startsWith(`${workspace.root}/`) && existsSync(absolute)) return absolute;
  }
  return null;
}

/**
 * Reads the request body and parses it as JSON.
 * @param request - the incoming request
 * @returns the parsed body, or an empty object
 */
async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

/**
 * Writes a JSON response.
 * @param response - the server response
 * @param status - the HTTP status code
 * @param body - the payload to serialise
 */
function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

/**
 * Loads the saved service presets from disk.
 * @returns the preset map, empty when none have been saved
 */
async function readPresets() {
  try {
    return JSON.parse(await readFile(PRESETS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Serves a file from the public directory.
 * @param response - the server response
 * @param name - the file name requested
 */
async function serveStatic(response, name) {
  const file = name === '/' ? 'index.html' : name.slice(1);
  const absolute = resolvePath(join(HERE, 'public'), file);
  if (!absolute.startsWith(join(HERE, 'public'))) {
    sendJson(response, 403, { error: 'forbidden' });
    return;
  }
  try {
    const body = await readFile(absolute);
    const extension = file.slice(file.lastIndexOf('.'));
    // The page is edited constantly; a cached copy silently hides every change.
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extension] ?? 'text/plain',
      'cache-control': 'no-store, must-revalidate',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'not found' });
  }
}

const routes = {
  'POST /api/repos': async (request, response) => {
    const { path: candidate, name } = await readJsonBody(request);
    const root = asWorkspace(candidate);
    if (root === null) {
      sendJson(response, 400, { error: `No nx.json found in "${candidate}" — that is not an Nx workspace.` });
      return;
    }
    const label = name?.trim() || root.split('/').filter(Boolean).pop();
    if (workspaces.has(label) && workspaces.get(label).root !== root) {
      sendJson(response, 400, { error: `A workspace named "${label}" is already open. Give this one another name.` });
      return;
    }
    const repos = settings.repos.filter((repo) => repo.path !== root);
    repos.push({ name: label, path: root });
    settings = await saveSettings(SETTINGS_PATH, settings, { repos });
    await addWorkspace(label, root);
    await refreshExternal();
    await refreshStats();
    sendJson(response, 200, { repos: settings.repos, added: label });
  },

  'POST /api/repos/order': async (request, response) => {
    const { order } = await readJsonBody(request);
    if (!Array.isArray(order)) {
      sendJson(response, 400, { error: 'order must be a list of workspace names' });
      return;
    }
    const byName = new Map(settings.repos.map((repo) => [repo.name, repo]));
    const reordered = order.map((name) => byName.get(name)).filter(Boolean);
    for (const repo of settings.repos) if (!reordered.includes(repo)) reordered.push(repo);
    settings = await saveSettings(SETTINGS_PATH, settings, { repos: reordered });
    sendJson(response, 200, { repos: settings.repos });
  },

  'POST /api/repos/remove': async (request, response) => {
    const { name } = await readJsonBody(request);
    const workspace = workspaces.get(name);
    if (workspace) {
      workspace.dispose();
      workspaces.delete(name);
    }
    settings = await saveSettings(SETTINGS_PATH, settings, {
      repos: settings.repos.filter((repo) => repo.name !== name),
    });
    await refreshStats();
    sendJson(response, 200, { repos: settings.repos });
  },

  'GET /api/state': async (_request, response) => {
    const open = [];
    for (const [name, workspace] of workspaces) {
      open.push({
        name,
        root: workspace.root,
        projects: workspace.projects,
        statuses: workspace.runner.statuses(),
        queued: workspace.runner.queued(),
        muted: workspace.runner.muted(),
        staleness: workspace.watcher.staleness(),
        external: workspace.external,
        index: workspace.index?.meta ?? { sites: 0, files: 0, tookMs: 0 },
      });
    }
    const order = settings.repos.map((repo) => repo.name);
    open.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    sendJson(response, 200, {
      workspaces: open,
      needsRepo: workspaces.size === 0,
      repos: settings.repos,
      presets: await readPresets(),
      version: VERSION,
      home: process.env.HOME ?? '',
      stats,
      settings,
      tailDir: TAIL_DIR,
      tailed: tailer.tailed(),
    });
  },

  'POST /api/start': async (request, response) => {
    const { repo, name, live, force } = await readJsonBody(request);
    const workspace = workspaceFor(repo);
    const project = workspace?.project(name);
    if (!project) {
      sendJson(response, 404, { error: `unknown service "${name}" in "${repo ?? 'the open workspace'}"` });
      return;
    }
    if (force !== true) {
      // Count everything booting anywhere: the machine does not care which
      // repository a webpack build belongs to.
      let booting = 0;
      for (const other of workspaces.values()) {
        booting += Object.values(other.runner.statuses()).filter((entry) => entry.status === 'starting').length;
      }
      const warnings = await preflight(workspace.root, project, booting);
      if (warnings.length > 0) {
        sendJson(response, 409, { warnings });
        return;
      }
    }
    const queued = startService(workspace, name, { live });
    if (queued) await workspace.watchSources(name);
    sendJson(response, 200, { queued, position: workspace.runner.queued().indexOf(name) + 1 });
  },

  'POST /api/stop': async (request, response) => {
    const { repo, name } = await readJsonBody(request);
    const workspace = workspaceFor(repo);
    if (!workspace) {
      sendJson(response, 404, { error: 'unknown workspace' });
      return;
    }
    if (workspace.external[name]) {
      const killed = await killExternal(workspace.external[name].pid);
      delete workspace.external[name];
      workspace.watcher.untrack(name);
      broadcast('external', { workspaces: externalByWorkspace() });
      sendJson(response, 200, { stopped: killed, wasExternal: true });
      return;
    }
    const stopped = workspace.runner.stop(name);
    if (stopped) workspace.watcher.untrack(name);
    sendJson(response, 200, { stopped });
  },

  'POST /api/restart': async (request, response) => {
    const { repo, name } = await readJsonBody(request);
    const workspace = workspaceFor(repo);
    if (!workspace) {
      sendJson(response, 404, { error: 'unknown workspace' });
      return;
    }
    if (workspace.external[name]) {
      await killExternal(workspace.external[name].pid);
      delete workspace.external[name];
      broadcast('external', { workspaces: externalByWorkspace() });
    } else {
      workspace.runner.stop(name);
    }
    const previous = workspace.runner.statuses()[name]?.mode;
    setTimeout(async () => {
      startService(workspace, name, { live: previous === 'live' });
      await workspace.watchSources(name);
    }, 2000);
    sendJson(response, 200, { restarting: true });
  },

  'POST /api/stop-all': async (request, response) => {
    const { repo } = await readJsonBody(request);
    const targets = repo ? [workspaces.get(repo)].filter(Boolean) : [...workspaces.values()];
    const stopped = [];
    for (const workspace of targets) {
      for (const name of workspace.runner.stopAll()) {
        workspace.watcher.untrack(name);
        stopped.push(`${workspace.name}/${name}`);
      }
      for (const name of Object.keys(workspace.external)) {
        await killExternal(workspace.external[name].pid);
        stopped.push(`${workspace.name}/${name}`);
      }
      workspace.external = {};
    }
    broadcast('external', { workspaces: externalByWorkspace() });
    sendJson(response, 200, { stopped });
  },

  'POST /api/mute': async (request, response) => {
    const { repo, name, muted } = await readJsonBody(request);
    const workspace = workspaceFor(repo);
    if (!workspace) {
      sendJson(response, 404, { error: 'unknown workspace' });
      return;
    }
    workspace.runner.setMuted(name, muted === true);
    sendJson(response, 200, { muted: workspace.runner.muted() });
  },

  'POST /api/resolve': async (request, response) => {
    const { repo, msg, context, service } = await readJsonBody(request);
    const workspace = workspaceFor(repo);
    if (!workspace?.index) {
      sendJson(response, 200, { match: null, confidence: 'none', candidates: [] });
      return;
    }
    const serviceRoot = service ? workspace.project(service)?.root : undefined;
    sendJson(response, 200, workspace.index.resolve(msg, context ?? null, { serviceRoot }));
  },

  // Opening a file and reading it back are what makes a log line clickable. Both
  // take the record's repo, because the same relative path exists in every open
  // workspace and the wrong one would show the wrong code.
  'POST /api/open': async (request, response) => {
    const { repo, file, line } = await readJsonBody(request);
    const absolute = safeRepoPath(file, repo);
    if (absolute === null) {
      sendJson(response, 400, { error: 'path outside repository' });
      return;
    }
    const [command, ...args] = EDITOR_CMD.split(/\s+/).map((part) =>
      part.replace('{file}', absolute).replace('{line}', String(line ?? 1)),
    );
    try {
      spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    } catch (error) {
      sendJson(response, 500, { error: `could not run "${command}": ${error.message}` });
      return;
    }
    sendJson(response, 200, { opened: true, via: command });
  },

  'POST /api/source': async (request, response) => {
    const { repo, file, line, radius } = await readJsonBody(request);
    const absolute = safeRepoPath(file, repo);
    if (absolute === null) {
      sendJson(response, 400, { error: 'path outside repository' });
      return;
    }
    const span = radius ?? 12;
    const lines = (await readFile(absolute, 'utf8')).split('\n');
    const from = Math.max(1, (line ?? 1) - span);
    const to = Math.min(lines.length, (line ?? 1) + span);
    sendJson(response, 200, { from, to, lines: lines.slice(from - 1, to) });
  },

  'POST /api/settings': async (request, response) => {
    const changes = await readJsonBody(request);
    settings = await saveSettings(SETTINGS_PATH, settings, changes);
    applySettings();
    broadcast('settings', { settings });
    sendJson(response, 200, settings);
  },

  'POST /api/presets': async (request, response) => {
    const presets = await readJsonBody(request);
    await mkdir(dirname(PRESETS_PATH), { recursive: true });
    await writeFile(PRESETS_PATH, JSON.stringify(presets, null, 2));
    sendJson(response, 200, { saved: true });
  },

  'POST /api/reindex': async (request, response) => {
    const { repo } = await readJsonBody(request);
    const targets = repo ? [workspaces.get(repo)].filter(Boolean) : [...workspaces.values()];
    const meta = {};
    for (const workspace of targets) meta[workspace.name] = await workspace.reindex();
    sendJson(response, 200, meta);
  },

  // Frees the buffer, server and every connected tab. Distinct from the "clear
  // screen" button on the page, which only moves a watermark and keeps the data —
  // this one actually releases the memory, and cannot be undone.
  'POST /api/clear': async (_request, response) => {
    buffer.length = 0;
    bufferBytes = 0;
    broadcast('cleared', {});
    sendJson(response, 200, { cleared: true });
  },
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  if (url.pathname === '/api/logs') {
    const limit = Number(url.searchParams.get('limit') ?? 2000);
    sendJson(response, 200, buffer.slice(-limit));
    return;
  }

  const handler = routes[`${request.method} ${url.pathname}`];
  if (handler) {
    try {
      await handler(request, response);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET') {
    await serveStatic(response, url.pathname);
    return;
  }

  sendJson(response, 404, { error: 'not found' });
});

if (process.argv.includes('--resume')) {
  try {
    const session = JSON.parse(await readFile(SESSION_PATH, 'utf8'));
    for (const entry of session.services ?? []) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const mode = typeof entry === 'string' ? 'plain' : entry.mode;
      const workspace = workspaceFor(typeof entry === 'string' ? undefined : entry.repo);
      if (!workspace?.project(name)) continue;
      startService(workspace, name, { live: mode === 'live' });
      await workspace.watchSources(name);
    }
    process.stdout.write(`resuming ${session.services?.length ?? 0} service(s) from the last session\n`);
  } catch {
    process.stdout.write('no previous session to resume\n');
  }
}

await tailer.start();

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${PORT} is already in use — helm-dev may already be running.\n`);
    process.stderr.write(`Find it with:  ss -lptn 'sport = :${PORT}'\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`helm-dev v${VERSION} → http://localhost:${PORT}\n`);
  if (workspaces.size === 0) {
    process.stdout.write('no workspace configured yet — open the page to point it at one\n');
  } else {
    for (const workspace of workspaces.values()) {
      process.stdout.write(
        `${workspace.name}: ${workspace.projects.length} projects, ${workspace.index.meta.sites} log sites` +
          `, ${Object.keys(workspace.external).length} started elsewhere\n`,
      );
    }
  }
  process.stdout.write(`tailing ${TAIL_DIR}/<service>.log · editor: ${EDITOR_CMD.split(/\s+/)[0]}\n`);
  process.stdout.write(
    `buffer ${BUFFER_OVERRIDE_MB ?? settings.bufferMB}MB (FIFO) · starts ${settings.resolvedConcurrency} at a time` +
      `${settings.startConcurrency === null ? ' (auto)' : ''} · rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB\n`,
  );
});

let shuttingDown = false;

/**
 * Stops every service helm-dev started, records them for `--resume`, and waits
 * for them to actually exit before leaving.
 * @param signal - the signal that triggered the shutdown
 */
function shutdown(signal) {
  // A second Ctrl-C is a habit, not a new instruction: leave immediately without
  // overwriting the resume list with an empty one.
  if (shuttingDown) {
    process.stdout.write('\nforced exit — services may still be shutting down\n');
    process.exit(130);
  }
  shuttingDown = true;

  const services = [];
  for (const workspace of workspaces.values()) {
    const before = workspace.runner.statuses();
    for (const name of workspace.dispose()) {
      services.push({ repo: workspace.name, name, mode: before[name]?.mode ?? 'plain' });
    }
  }
  const stopped = services.map((entry) => `${entry.repo}/${entry.name}`);
  if (services.length > 0) {
    try {
      writeFileSync(SESSION_PATH, JSON.stringify({ stoppedAt: new Date().toISOString(), services }));
    } catch {
      // Losing the session note is not worth failing the shutdown over.
    }
  }
  process.stdout.write(`\n${signal} — stopping ${stopped.length} service(s)\n`);

  const deadline = Date.now() + 6000;
  const waitForExit = setInterval(() => {
    let alive = 0;
    for (const workspace of workspaces.values()) {
      alive += Object.values(workspace.runner.statuses()).filter((entry) => entry.status !== 'stopped').length;
    }
    if (alive === 0 || Date.now() > deadline) {
      clearInterval(waitForExit);
      if (alive > 0) process.stdout.write(`${alive} service(s) did not exit in time; they were signalled\n`);
      if (stopped.length > 0) process.stdout.write(`bring them back with:  ./helm-dev --resume\n`);
      process.exit(0);
    }
  }, 150);
}

// SIGHUP matters too: closing the terminal should not orphan the services.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal));
}
