import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './lib/projects.mjs';
import { detectExternal, killExternal } from './lib/detect.mjs';
import { loadIndex } from './lib/log-index.mjs';
import { ServiceRunner } from './lib/runner.mjs';
import { SourceWatcher } from './lib/watcher.mjs';
import { gitStatus, serviceMemory } from './lib/stats.mjs';
import { availableMemoryMB, preflight } from './lib/preflight.mjs';
import { LogTailer } from './lib/tailer.mjs';
import { loadSettings, saveSettings } from './lib/settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// package.json is the single source of the version; the UI and the banner read it.
const VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;

/**
 * Confirms a path is an Nx workspace devscope can work with.
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
 * devscope is run from inside one.
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
const PORT = Number(process.env.DEVSCOPE_PORT ?? 7788);
// Whatever the OS calls its temp directory, and per-user so two people on one
// box do not tail each other's files.
const TAIL_DIR = process.env.DEVSCOPE_TAIL_DIR ?? join(tmpdir(), `devscope-logs-${userInfo().username}`);
// Any editor, not just VSCode: {file} and {line} are substituted.
const EDITOR_CMD = process.env.DEVSCOPE_EDITOR ?? 'code -g {file}:{line}';
let bufferBudget = 50 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8192;
const DETECT_INTERVAL_MS = Number(process.env.DEVSCOPE_DETECT_MS ?? 8000);

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const buffer = [];
let bufferBytes = 0;
const clients = new Set();
let sequence = 0;

await mkdir(join(HERE, '.cache'), { recursive: true });
let settings = await loadSettings(SETTINGS_PATH);
let repoRoot = null;
let repoName = null;
let runner = null;
let watcher = null;
const tailer = new LogTailer(TAIL_DIR);
let projects = [];
let projectNames = new Set();
let index = null;
let external = {};
let stats = { services: {}, git: null, devscope: 0 };

/**
 * Points devscope at a workspace, building everything derived from it. Called at
 * startup and whenever the active repository changes.
 * @param root - absolute path to the workspace
 * @param name - the label to show for it
 */
async function activateRepo(root, name) {
  if (runner) runner.stopAll();
  if (watcher) for (const service of Object.keys(watcher.staleness())) watcher.untrack(service);

  repoRoot = root;
  repoName = name ?? root.split('/').filter(Boolean).pop();
  runner = new ServiceRunner(repoRoot);
  watcher = new SourceWatcher(repoRoot);
  projects = await discoverProjects(repoRoot);
  projectNames = new Set(projects.map((project) => project.name));
  index = await loadIndex(repoRoot, cachePathFor(repoRoot), process.argv.includes('--reindex'));
  external = {};

  runner.on('log', (record) => broadcast('log', record));
  runner.on('status', (status) => broadcast('status', status));
  watcher.on('stale', (event) => broadcast('stale', event));
  applySettings();
}

/**
 * Gives each workspace its own index cache, so switching does not rebuild.
 * @param root - absolute path to the workspace
 * @returns the cache file path for that workspace
 */
function cachePathFor(root) {
  const slug = root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return join(HERE, '.cache', `log-sites-${slug}.json`);
}

/**
 * Applies machine-level settings to the pieces that enforce them.
 */
function applySettings() {
  // The buffer budget applies with or without a workspace; the rest needs one.
  bufferBudget = Math.max(1, settings.bufferMB) * 1024 * 1024;
  while (bufferBytes > bufferBudget && buffer.length > 1) {
    bufferBytes -= buffer.shift().bytes;
  }
  if (runner === null) return;
  runner.setConcurrency(settings.resolvedConcurrency);
  // Angular build output is voluminous and rarely what anyone is debugging.
  for (const project of projects.filter((candidate) => candidate.kind === 'frontend')) {
    runner.setMuted(project.name, settings.muteFrontends);
  }
}

applySettings();

/**
 * Appends a record to the ring buffer and pushes it to every connected browser.
 * @param type - the event type, log or status
 * @param payload - the event body
 */
/**
 * Approximates a record's footprint without serialising it twice.
 * @param record - the log record
 * @returns its size in bytes
 */
function recordBytes(record) {
  const fields = record.fields === null || record.fields === undefined ? 0 : JSON.stringify(record.fields).length;
  return (record.msg?.length ?? 0) + (record.context?.length ?? 0) + (record.service?.length ?? 0) + fields + 64;
}

/**
 * Caps one record's payload, so a single huge dump cannot evict the whole buffer.
 * @param record - the log record, modified in place
 */
function capPayload(record) {
  if (typeof record.fields?.detail !== 'string' || record.fields.detail.length <= MAX_PAYLOAD_BYTES) return;
  const kept = record.fields.detail.slice(0, MAX_PAYLOAD_BYTES);
  record.fields = { ...record.fields, detail: `${kept}\n… truncated, payload exceeded ${MAX_PAYLOAD_BYTES} bytes` };
}

function broadcast(type, payload) {
  sequence += 1;
  const event = { type, seq: sequence, ...payload };
  if (type === 'log') {
    capPayload(event);
    event.bytes = recordBytes(event);
    buffer.push(event);
    bufferBytes += event.bytes;
    // FIFO: drop the oldest lines until the buffer is back inside its budget.
    while (bufferBytes > bufferBudget && buffer.length > 1) {
      bufferBytes -= buffer.shift().bytes;
    }
  }
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(frame);
}

tailer.on('log', (record) => broadcast('log', record));

/**
 * Looks up a project by name.
 * @param name - the project name
 * @returns the project, or undefined when unknown
 */
function projectByName(name) {
  return projects.find((project) => project.name === name);
}

/**
 * Starts a service the one way devscope knows how, so the API, a restart and a
 * resume all apply the same rules.
 * @param name - the project name
 * @param options - `live` for a frontend dev server that reloads, `watch` for a
 *   backend devscope restarts itself
 * @returns whether it was queued
 */
function startService(name, options = {}) {
  // Only an Angular dev server can reload itself, and doing so costs gigabytes,
  // so a plain start switches watching and reloading off explicitly. Backends
  // are always started plain — they have no equivalent.
  const isFrontend = projectByName(name)?.kind === 'frontend';
  const live = isFrontend && options.live === true;
  const args = isFrontend && !live ? ['--watch=false', '--liveReload=false'] : [];
  return runner.enqueue(name, { args, mode: live ? 'live' : 'plain', kind: projectByName(name)?.kind ?? 'app' });
}

/**
 * Begins watching a service's sources so later edits mark it stale.
 * @param name - the project name
 */
async function watchSources(name) {
  const project = projectByName(name);
  // Angular's dev server watches and rebuilds by itself, so tracking its sources
  // would only produce a stale badge for something that is never stale.
  if (!project?.sourceRoot || project.kind === 'frontend') return;
  await watcher.track(name, project.sourceRoot);
}

/**
 * Re-scans for services started outside devscope and reports any change.
 */
async function refreshExternal() {
  const found = await detectExternal(repoRoot, projectNames);
  const owned = runner.statuses();
  for (const name of Object.keys(found)) {
    const mine = owned[name];
    // Anything devscope still holds a process for is not "external", whatever
    // state that process is in — a failed start can leave the wrapper alive.
    if (mine && (mine.status !== 'stopped' || mine.pid === found[name].pid)) delete found[name];
  }
  if (JSON.stringify(found) !== JSON.stringify(external)) {
    for (const name of Object.keys(found)) {
      if (!(name in external)) await watchSources(name);
    }
    external = found;
    broadcast('external', { external });
  }
}

/**
 * Recomputes per-service memory and the repository's git state.
 */
async function refreshStats() {
  const roots = {};
  for (const [name, entry] of Object.entries(runner.statuses())) {
    if (entry.pid !== null && entry.status !== 'stopped') roots[name] = entry.pid;
  }
  for (const [name, entry] of Object.entries(external)) roots[name] = entry.pid;

  const [services, git] = await Promise.all([serviceMemory(roots), gitStatus(repoRoot)]);
  stats = {
    services,
    git,
    devscope: Math.round(process.memoryUsage().rss / 1048576),
    availableMB: await availableMemoryMB(),
    watches: watcher.watchCount(),
    buffered: buffer.length,
    bufferMB: Math.round((bufferBytes / 1048576) * 10) / 10,
    bufferMaxMB: settings.bufferMB,
    concurrency: runner.concurrency(),
  };
  broadcast('stats', { stats });
}

const startupRepo =
  asWorkspace(process.env.DEVSCOPE_REPO) ??
  asWorkspace(settings.activeRepo) ??
  asWorkspace(settings.repos[0]?.path) ??
  workspaceAboveCwd();

if (startupRepo !== null) {
  const known = settings.repos.find((repo) => repo.path === startupRepo);
  if (!known) {
    const repos = [...settings.repos, { name: startupRepo.split('/').filter(Boolean).pop(), path: startupRepo }];
    settings = await saveSettings(SETTINGS_PATH, settings, { repos, activeRepo: startupRepo });
  }
  await activateRepo(startupRepo, settings.repos.find((repo) => repo.path === startupRepo)?.name);
  await refreshExternal();
  await refreshStats();
}
setInterval(() => {
  if (repoRoot === null) return;
  refreshExternal()
    .then(() => refreshStats())
    .catch(() => undefined);
}, DETECT_INTERVAL_MS);

/**
 * Rejects paths that escape the monorepo, since the UI can ask to open arbitrary files.
 * @param relativePath - a repo-relative path from the client
 * @returns the absolute path, or null when it is outside the repo
 */
function safeRepoPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  const absolute = resolvePath(repoRoot, relativePath);
  return absolute.startsWith(`${repoRoot}/`) ? absolute : null;
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
    const repos = settings.repos.filter((repo) => repo.path !== root);
    repos.push({ name: name?.trim() || root.split('/').filter(Boolean).pop(), path: root });
    settings = await saveSettings(SETTINGS_PATH, settings, { repos, activeRepo: root });
    await activateRepo(root, repos[repos.length - 1].name);
    await refreshExternal();
    await refreshStats();
    sendJson(response, 200, { repos: settings.repos, active: root });
  },

  'GET /api/state': async (_request, response) => {
    sendJson(response, 200, {
      projects,
      statuses: runner === null ? {} : runner.statuses(),
      presets: await readPresets(),
      index: index === null ? { sites: 0, files: 0, tookMs: 0 } : index.meta,
      repoRoot,
      repoName,
      repos: settings.repos,
      needsRepo: repoRoot === null,
      version: VERSION,
      external,
      queued: runner === null ? [] : runner.queued(),
      stats,
      settings,
      muted: runner === null ? [] : runner.muted(),
      staleness: watcher === null ? {} : watcher.staleness(),
      tailDir: TAIL_DIR,
      tailed: tailer.tailed(),
    });
  },

  'POST /api/start': async (request, response) => {
    const { name, live, force } = await readJsonBody(request);
    const project = projectByName(name);
    if (!project) {
      sendJson(response, 404, { error: `unknown service "${name}"` });
      return;
    }
    if (force !== true) {
      const booting = Object.values(runner.statuses()).filter((entry) => entry.status === 'starting').length;
      const warnings = await preflight(repoRoot, project, booting);
      if (warnings.length > 0) {
        sendJson(response, 409, { warnings });
        return;
      }
    }
    const queued = startService(name, { live });
    if (queued) await watchSources(name);
    sendJson(response, 200, { queued, position: runner.queued().indexOf(name) + 1 });
  },

  'POST /api/settings': async (request, response) => {
    const changes = await readJsonBody(request);
    settings = await saveSettings(SETTINGS_PATH, settings, changes);
    applySettings();
    broadcast('settings', { settings });
    sendJson(response, 200, settings);
  },

  'POST /api/stop-all': async (_request, response) => {
    const stopped = runner.stopAll();
    for (const name of stopped) watcher.untrack(name);
    for (const name of Object.keys(external)) {
      await killExternal(external[name].pid);
      stopped.push(name);
    }
    external = {};
    broadcast('external', { external });
    sendJson(response, 200, { stopped });
  },

  'POST /api/mute': async (request, response) => {
    const { name, muted } = await readJsonBody(request);
    runner.setMuted(name, muted === true);
    sendJson(response, 200, { muted: runner.muted() });
  },

  'POST /api/stop': async (request, response) => {
    const { name } = await readJsonBody(request);
    if (external[name]) {
      const killed = await killExternal(external[name].pid);
      delete external[name];
      watcher.untrack(name);
      broadcast('external', { external });
      sendJson(response, 200, { stopped: killed, wasExternal: true });
      return;
    }
    const stopped = runner.stop(name);
    if (stopped) watcher.untrack(name);
    sendJson(response, 200, { stopped });
  },

  'POST /api/restart': async (request, response) => {
    const { name } = await readJsonBody(request);
    if (external[name]) {
      await killExternal(external[name].pid);
      delete external[name];
      broadcast('external', { external });
    } else {
      runner.stop(name);
    }
    const previous = runner.statuses()[name]?.mode;
    setTimeout(async () => {
      startService(name, { live: previous === 'live' });
      await watchSources(name);
    }, 2000);
    sendJson(response, 200, { restarting: true });
  },

  'POST /api/resolve': async (request, response) => {
    const { msg, context, service } = await readJsonBody(request);
    const serviceRoot = service ? projectByName(service)?.root : undefined;
    sendJson(response, 200, index.resolve(msg, context ?? null, { serviceRoot }));
  },

  'POST /api/open': async (request, response) => {
    const { file, line } = await readJsonBody(request);
    const absolute = safeRepoPath(file);
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
    const { file, line, radius } = await readJsonBody(request);
    const absolute = safeRepoPath(file);
    if (absolute === null) {
      sendJson(response, 400, { error: 'path outside repository' });
      return;
    }
    const span = radius ?? 12;
    const text = await readFile(absolute, 'utf8');
    const lines = text.split('\n');
    const from = Math.max(1, (line ?? 1) - span);
    const to = Math.min(lines.length, (line ?? 1) + span);
    sendJson(response, 200, { from, to, lines: lines.slice(from - 1, to) });
  },

  'POST /api/presets': async (request, response) => {
    const presets = await readJsonBody(request);
    await writeFile(PRESETS_PATH, JSON.stringify(presets, null, 2));
    sendJson(response, 200, { saved: true });
  },

  'POST /api/reindex': async (_request, response) => {
    index = await loadIndex(repoRoot, cachePathFor(repoRoot), true);
    sendJson(response, 200, index.meta);
  },

  'POST /api/clear': async (_request, response) => {
    buffer.length = 0;
    bufferBytes = 0;
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
      startService(name, { live: mode === 'live' });
      await watchSources(name);
    }
    process.stdout.write(`resuming ${session.services?.length ?? 0} service(s) from the last session\n`);
  } catch {
    process.stdout.write('no previous session to resume\n');
  }
}

await tailer.start();

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${PORT} is already in use — devscope may already be running.\n`);
    process.stderr.write(`Find it with:  ss -lptn 'sport = :${PORT}'\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`devscope v${VERSION} → http://localhost:${PORT}\n`);
  if (index === null) {
    process.stdout.write('no workspace configured yet — open the page to point it at one\n');
  } else {
    process.stdout.write(
      `${repoName}: indexed ${index.meta.sites} log sites from ${index.meta.files} files in ${index.meta.tookMs}ms\n`,
    );
    process.stdout.write(`detected ${Object.keys(external).length} externally started service(s)\n`);
  }
  process.stdout.write(`tailing ${TAIL_DIR}/<service>.log · editor: ${EDITOR_CMD.split(/\s+/)[0]}\n`);
  process.stdout.write(
    `buffer ${settings.bufferMB}MB (FIFO) · starts ${settings.resolvedConcurrency} at a time` +
      `${settings.startConcurrency === null ? ' (auto)' : ''} · rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB\n`,
  );
});

let shuttingDown = false;

/**
 * Stops every service devscope started, records them for `--resume`, and waits
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

  const before = runner.statuses();
  const stopped = runner.stopAll();
  if (stopped.length > 0) {
    try {
      const services = stopped.map((name) => ({ name, mode: before[name]?.mode ?? 'plain' }));
      writeFileSync(SESSION_PATH, JSON.stringify({ stoppedAt: new Date().toISOString(), services }));
    } catch {
      // Losing the session note is not worth failing the shutdown over.
    }
  }
  process.stdout.write(`\n${signal} — stopping ${stopped.length} service(s)\n`);

  const deadline = Date.now() + 6000;
  const waitForExit = setInterval(() => {
    const alive = Object.values(runner.statuses()).filter((entry) => entry.status !== 'stopped').length;
    if (alive === 0 || Date.now() > deadline) {
      clearInterval(waitForExit);
      if (alive > 0) process.stdout.write(`${alive} service(s) did not exit in time; they were signalled\n`);
      if (stopped.length > 0) process.stdout.write(`bring them back with:  ./run.sh --resume\n`);
      process.exit(0);
    }
  }, 150);
}

// SIGHUP matters too: closing the terminal should not orphan the services.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal));
}
