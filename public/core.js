// The pieces every other module needs: the one shared state object, the elements
// it renders into, and the handful of helpers that have no better home.

// Nest logs its own bootstrap through these contexts, from inside node_modules.
export const FRAMEWORK_CONTEXTS = new Set([
  'RouterExplorer',
  'InstanceLoader',
  'NestFactory',
  'RoutesResolver',
  'NestApplication',
  'NestMicroservice',
  'WebSocketsController',
  'LegacyRouteConverter',
]);

export const state = {
  workspaces: [],
  presets: {},
  logs: [],

  focus: new Set(),

  hiddenBelow: 0,
  stats: { services: {}, git: null },
  repo: '',
  showNoise: false,
  bytes: 0,
  trace: null,
  expanded: new Set(),
  collapsed: new Set(),
  pinned: new Set(),
  serviceFilter: '',
  levels: new Set(['error', 'warn', 'info', 'debug', 'raw']),
  search: '',
  follow: true,
  selected: null,
};

export const el = {
  services: document.getElementById('services'),
  presets: document.getElementById('presets'),
  logs: document.getElementById('logs'),
  spacer: document.getElementById('logsSpacer'),
  window: document.getElementById('logsWindow'),
  detail: document.getElementById('detail'),
  split: document.getElementById('split'),
  count: document.getElementById('count'),
  search: document.getElementById('search'),
  indexMeta: document.getElementById('indexMeta'),
};

/**
 * Posts JSON to a helm-dev endpoint.
 * @param path - the API path
 * @param body - the payload
 * @returns the parsed response
 */
export async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    console.warn(`${path} → ${response.status}`);
    // Every endpoint the page calls is checked against the server before commit,
    // so a 404 is never a typo: it is a server process started before the route
    // existed. Node does not reload a running server, and a dead button gives no
    // hint of that, so the page says it outright.
    if (response.status === 404) reportStaleServer(path);
  }
  return response.json();
}

/**
 * Warns, once, that the server is older than the page talking to it.
 * @param path - the endpoint that came back missing
 */
function reportStaleServer(path) {
  if (document.getElementById('staleServer')) return;
  const banner = document.createElement('div');
  banner.id = 'staleServer';
  banner.className = 'stale-server';
  banner.innerHTML = `<strong>The running helm-dev server is older than this page.</strong>
    <span><code>${path}</code> is missing from it. Restart it: <code>Ctrl-C</code>,
    then <code>./helm-dev --resume</code></span>
    <button class="mini" onclick="this.parentElement.remove()">dismiss</button>`;
  document.body.append(banner);
}

/**
 * Escapes text for safe insertion into innerHTML.
 * @param value - the raw text
 * @returns the escaped text
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

/**
 * Formats a record's full timestamp, for the cases where the exact moment matters.
 * @param at - epoch milliseconds
 * @returns a sortable local timestamp with milliseconds
 */
export function formatExactTime(at) {
  const date = new Date(at);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Formats a run length for the "done" badge.
 * @param ms - how long the job ran
 * @returns a short human duration
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

/**
 * Formats a timestamp as a local wall-clock time with milliseconds.
 * @param at - epoch milliseconds
 * @returns the formatted time
 */
export function formatTime(at) {
  const date = new Date(at);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * The key a service is addressed by. Names repeat across repositories, so the
 * workspace has to be part of the identity everywhere in the UI.
 * @param repo - the workspace name
 * @param name - the service name
 * @returns the composite key
 */
export function key(repo, name) {
  return `${repo}/${name}`;
}

/**
 * Finds a workspace by name.
 * @param repo - the workspace name
 * @returns the workspace record, or undefined
 */
export function workspaceOf(repo) {
  return state.workspaces.find((workspace) => workspace.name === repo);
}

/**
 * Reads a remembered UI preference.
 * @param key - the preference name
 * @param fallback - value to use when nothing is stored
 * @returns the stored value, or the fallback
 */
export function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`helmdev.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Reads a preference that was stored before it was JSON, for one migration.
 * @param key - the preference name
 * @returns the stored text, or null
 */
export function rawPref(key) {
  try {
    return localStorage.getItem(`helmdev.${key}`);
  } catch {
    return null;
  }
}

/**
 * Remembers a UI preference across reloads.
 * @param key - the preference name
 * @param value - the value to store
 */
export function writePref(key, value) {
  try {
    localStorage.setItem(`helmdev.${key}`, JSON.stringify(value));
  } catch {
    // Storage is unavailable in private windows; preferences simply reset.
  }
}
