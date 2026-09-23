// Nest logs its own bootstrap through these contexts, from inside node_modules.
const FRAMEWORK_CONTEXTS = new Set([
  'RouterExplorer',
  'InstanceLoader',
  'NestFactory',
  'RoutesResolver',
  'NestApplication',
  'NestMicroservice',
  'WebSocketsController',
  'LegacyRouteConverter',
]);

const state = {
  projects: [],
  statuses: {},
  presets: {},
  logs: [],
  external: {},
  staleness: {},
  focus: new Set(),
  queued: [],
  muted: new Set(),
  hiddenBelow: 0,
  stats: { services: {}, git: null },
  repo: '',
  showNoise: false,
  bytes: 0,
  trace: null,
  expanded: new Set(),
  levels: new Set(['error', 'warn', 'info', 'debug', 'raw']),
  search: '',
  follow: true,
  selected: null,
};

const el = {
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
 * Posts JSON to a devscope endpoint.
 * @param path - the API path
 * @param body - the payload
 * @returns the parsed response
 */
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return response.json();
}

/**
 * Starts a service, showing anything the server flagged as risky first. The
 * checks exist because the expensive mistakes — swapping the machine, or binding
 * a port something else holds — are invisible until they have already happened.
 * @param name - the project name
 * @param options - `live` for a frontend dev server with live reload
 */
async function startService(name, options = {}) {
  const result = await post('/api/start', { name, ...options });
  if (!result.warnings) return;
  const text = result.warnings.map((warning) => `• ${warning.message}`).join('\n\n');
  if (!confirm(`Start ${name} anyway?\n\n${text}`)) return;
  await post('/api/start', { name, ...options, force: true });
}

/**
 * Escapes text for safe insertion into innerHTML.
 * @param value - the raw text
 * @returns the escaped text
 */
function escapeHtml(value) {
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
function formatExactTime(at) {
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
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

/**
 * Formats a timestamp as a local wall-clock time with milliseconds.
 * @param at - epoch milliseconds
 * @returns the formatted time
 */
function formatTime(at) {
  const date = new Date(at);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

/* ---------- sidebar ---------- */

/**
 * Renders the service list with live status dots.
 */
function serviceState(name) {
  const own = state.statuses[name]?.status;
  if (['running', 'starting', 'stopping', 'failed', 'completed'].includes(own)) return own;
  if (state.queued.includes(name)) return 'queued';
  if (state.external[name]) return 'external';
  return 'stopped';
}

/**
 * Renders the service list with live status, staleness and per-service controls.
 */
const LIVE_ORDER = { failed: 0, running: 1, starting: 2, queued: 3, external: 4, stopping: 5, completed: 6, stopped: 7 };

/**
 * Orders the list so anything alive sits at the top, then by kind, then by name.
 * @returns the projects in display order
 */
function orderedProjects() {
  return [...state.projects].sort((a, b) => {
    const rank = LIVE_ORDER[serviceState(a.name)] - LIVE_ORDER[serviceState(b.name)];
    if (rank !== 0) return rank;
    const kinds = { app: 0, job: 1, frontend: 2, other: 3 };
    return kinds[a.kind] - kinds[b.kind] || a.name.localeCompare(b.name);
  });
}

/**
 * Enables the stop-all control only when something is actually running.
 */
function renderStopAll() {
  const liveCount = state.projects.filter((project) =>
    ['running', 'starting', 'queued', 'external', 'failed'].includes(serviceState(project.name)),
  ).length;
  const button = document.getElementById('stopAll');
  button.disabled = liveCount === 0;
  button.textContent = liveCount === 0 ? 'stop all' : `stop all (${liveCount})`;
}

function renderServices() {
  renderStopAll();
  el.services.innerHTML = orderedProjects()
    .map((project) => {
      const status = serviceState(project.name);
      const live = ['running', 'external', 'starting', 'queued', 'failed'].includes(status);
      const ranFor = state.statuses[project.name]?.ranForMs;
      const unconfirmed = status === 'running' && state.statuses[project.name]?.confirmed === false;
      const muted = state.muted.has(project.name);
      // Angular's dev server reloads itself; devscope neither watches nor restarts it.
      const isFrontend = project.kind === 'frontend';
      const mode = state.statuses[project.name]?.mode ?? 'plain';
      const failure = status === 'failed' ? state.statuses[project.name]?.reason : null;
      const focused = state.focus.has(project.name);
      const stale = live && state.staleness[project.name]?.stale === true;
      const changed = state.staleness[project.name]?.changed?.length ?? 0;
      const notes = [project.root];
      if (status === 'external') notes.push('started outside devscope — logs only via tail file');
      if (stale) notes.push(`${changed} file(s) changed since it started`);
      if (status === 'starting') notes.push('still booting — logs stream as it comes up');
      if (status === 'queued') notes.push('waiting to start — services boot one at a time');
      if (failure) notes.push(`did not boot: ${failure}`);
      if (status === 'completed') notes.push('finished its work and exited cleanly — press ▶ to run it again');
      if (isFrontend) {
        notes.push(mode === 'live' ? 'live reload on: rebuilds and refreshes on change' : 'started without live reload — use ▶live if you want it');
      }
      if (unconfirmed) notes.push('no boot signal seen — assumed up after 60s');
      if (muted) notes.push('logs muted — click the muted badge to enable');
      notes.push(live ? 'click to show only this service' : 'click ▶ to start');
      return `<div class="service ${stale ? 'stale' : ''} ${focused ? 'focused' : ''}" data-name="${project.name}" title="${escapeHtml(notes.join('\n'))}">
        <span class="dot ${status}"></span>
        <span class="name">${project.name}</span>
        ${stale ? `<span class="badge stale-badge">${changed}&#916;</span>` : ''}
        ${status === 'queued' ? `<span class="badge queued-badge">queued ${state.queued.indexOf(project.name) + 1}</span>` : ''}
        ${status === 'failed' ? '<span class="badge failed-badge">boot failed</span>' : ''}
        ${status === 'completed' ? `<span class="badge done-badge">done${ranFor ? ` ${formatDuration(ranFor)}` : ''}</span>` : ''}
        ${live && mode === 'live' ? '<span class="badge live-badge" title="started with live reload — rebuilds and refreshes the browser on change">live</span>' : ''}
        ${unconfirmed ? '<span class="badge queued-badge">unconfirmed</span>' : ''}
        ${muted ? '<span class="badge muted-badge" data-act="unmute" title="logs are off for this service — click to turn them on">muted</span>' : ''}
        ${state.stats.services[project.name] ? `<span class="mem">${state.stats.services[project.name]}M</span>` : ''}
        <span class="actions">
          ${live ? '<button class="mini" data-act="restart" title="stop and start again">&#10227;</button>' : ''}
          ${live ? '<button class="mini" data-act="stop" title="stop service">&times;</button>' : '<button class="mini" data-act="start" title="start service">&#9654;</button>'}
          ${!live && isFrontend
            ? '<button class="mini watch-start" data-act="live" title="start with live reload — rebuilds on change, but uses far more memory">&#9654;L</button>'
            : ''}
        </span>
      </div>`;
    })
    .join('');
}

/**
 * Renders the saved presets plus the control to save the running set as a new one.
 */
function renderPresets() {
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

/* ---------- logs ---------- */

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
function correlationIds(record) {
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
function passesFilters(record) {
  if (record.seq <= state.hiddenBelow) return false;
  if (!state.showNoise && isNoise(record)) return false;
  if (state.trace !== null && !correlationIds(record).some((id) => id.key === state.trace.key && id.value === state.trace.value)) {
    return false;
  }
  if (state.focus.size > 0 && !state.focus.has(record.service)) return false;
  const buckets = { fatal: 'error', error: 'error', warn: 'warn', info: 'info', debug: 'debug', trace: 'debug' };
  if (!state.levels.has(buckets[record.level] ?? 'raw')) return false;
  if (state.search.length === 0) return true;
  const haystack = `${record.service} ${record.context ?? ''} ${record.msg} ${JSON.stringify(record.fields ?? '')}`;
  return haystack.toLowerCase().includes(state.search.toLowerCase());
}

/**
 * Builds the markup for one log row.
 * @param record - the log record
 * @returns the row HTML
 */
function rowHtml(row) {
  const record = row.record;
  const selected = record.seq === state.selected ? ' selected' : '';
  const member = row.member ? ' member' : '';
  return `<div class="row ${record.level}${selected}${member}" data-seq="${record.seq}">
    <span class="time">${formatTime(record.at)}</span>
    <span class="svc">${escapeHtml(record.service)}</span>
    <span class="lvl ${record.level}">${record.level}</span>
    <span class="ctx">${escapeHtml(record.context ?? '')}</span>
    <span class="msg">${escapeHtml(record.msg)}</span>
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

// The server owns the budget; the tab mirrors it so it cannot outgrow it either.
let BUFFER_BUDGET_BYTES = 50 * 1024 * 1024;

const ROW_HEIGHT = 20;
const OVERSCAN = 12;
let visibleRecords = [];
let paintQueued = false;

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
  const index = Math.min(visibleRecords.length - 1, Math.floor(el.logs.scrollTop / ROW_HEIGHT));
  return { seq: visibleRecords[index].record.seq, offset: index * ROW_HEIGHT - el.logs.scrollTop };
}

/**
 * Scrolls so a given line sits where it was before the list changed.
 * @param anchor - the anchor captured before re-rendering
 */
function restoreAnchor(anchor) {
  if (anchor === null) return;
  let index = visibleRecords.findIndex((row) => row.record.seq >= anchor.seq);
  if (index === -1) index = visibleRecords.length - 1;
  const max = Math.max(0, visibleRecords.length * ROW_HEIGHT - el.logs.clientHeight);
  el.logs.scrollTop = Math.max(0, Math.min(max, index * ROW_HEIGHT - anchor.offset));
}

/**
 * Scrolls to the newest line and keeps the pane pinned there.
 */
function jumpToLatest() {
  el.logs.scrollTop = Math.max(0, visibleRecords.length * ROW_HEIGHT - el.logs.clientHeight);
  schedulePaint();
}

/**
 * Recomputes which records pass the filters, then repaints the visible window.
 * @param options - `anchor` pins a specific line in place across the re-render
 */
function renderLogs(options = {}) {
  const anchor = options.anchor === undefined ? currentAnchor() : options.anchor;
  visibleRecords = collapse(state.logs.filter(passesFilters));
  el.spacer.style.height = `${visibleRecords.length * ROW_HEIGHT}px`;
  el.count.textContent = `${visibleRecords.length} shown / ${state.logs.length} buffered`;
  if (state.follow) {
    el.logs.scrollTop = Math.max(0, visibleRecords.length * ROW_HEIGHT - el.logs.clientHeight);
  } else {
    restoreAnchor(anchor);
  }
  paintWindow();
}

/**
 * Renders just the slice of rows inside the viewport, offset into place.
 */
function paintWindow() {
  paintQueued = false;
  if (visibleRecords.length === 0) {
    el.window.style.transform = 'translateY(0)';
    el.window.innerHTML = emptyStateHtml();
    return;
  }
  const first = Math.max(0, Math.floor(el.logs.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(el.logs.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = visibleRecords.slice(first, first + count);
  el.window.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
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
 * Explains an empty log pane, which is almost always a service devscope did not spawn.
 * @returns the empty-state HTML
 */
function emptyStateHtml() {
  const focused = [...state.focus];
  const externals = focused.filter((name) => state.external[name]);
  const booting = focused.filter((name) => serviceState(name) === 'starting');
  const live = focused.filter((name) => serviceState(name) === 'running');
  const hidden = state.logs.filter((entry) => entry.seq <= state.hiddenBelow).length;

  const failed = focused.filter((name) => serviceState(name) === 'failed');
  if (failed.length > 0) {
    const reason = state.statuses[failed[0]]?.reason;
    return `<div class="empty">
      <p><strong>${failed.join(', ')}</strong> did not start.</p>
      ${reason ? `<p class="fail-reason">${escapeHtml(reason)}</p>` : ''}
      <p>Turn on <strong>raw</strong> and <strong>noise</strong> above to see the full build output,
      fix the cause, then press <strong>&#10227;</strong> to try again.</p>
    </div>`;
  }
  const done = focused.filter((name) => serviceState(name) === 'completed');
  if (done.length > 0 && hidden === 0) {
    const ran = state.statuses[done[0]]?.ranForMs;
    return `<div class="empty"><p><strong>${done.join(', ')}</strong> finished and exited cleanly${
      ran ? ` after ${formatDuration(ran)}` : ''
    }. Its output above is the whole run; press <strong>&#9654;</strong> to run it again.</p></div>`;
  }
  if (state.trace !== null) {
    return `<div class="empty"><p>No lines carry <strong>${escapeHtml(state.trace.key)}
      ${escapeHtml(state.trace.value)}</strong> in the buffer. Press <strong>Esc</strong> to drop the trace.</p></div>`;
  }
  if (hidden > 0) {
    const who = focused.length > 0 ? ` for <strong>${focused.join(', ')}</strong>` : '';
    return `<div class="empty"><p>Screen cleared${who}. <strong>${hidden}</strong> line(s) are still buffered —
      press <strong>restore</strong> to bring them back. New lines appear here as they arrive.</p></div>`;
  }
  if (live.length > 0 && externals.length === 0 && booting.length === 0) {
    return `<div class="empty"><p><strong>${live.join(', ')}</strong> is running and has not logged anything
      matching the current filters yet.</p></div>`;
  }

  if (externals.length > 0) {
    return `<div class="empty">
      <p><strong>${externals.join(', ')}</strong> ${externals.length === 1 ? 'was' : 'were'} started outside devscope,
      so its output goes to that terminal — devscope cannot attach to a process it did not spawn.</p>
      <p>Two ways to get these logs here:</p>
      <ol>
        <li>Press <strong>&#10227;</strong> on the service to stop it and start it under devscope.</li>
        <li>Keep your terminal and tee into the drop dir:
          <code>npm start ${externals[0]} 2&gt;&amp;1 | tee /tmp/devscope-logs/${externals[0]}.log</code></li>
      </ol>
    </div>`;
  }
  if (booting.length > 0) {
    return `<div class="empty"><p><strong>${booting.join(', ')}</strong> is still booting — the first lines
      appear as soon as the build finishes.</p></div>`;
  }
  if (focused.length > 0) {
    return `<div class="empty"><p>No logs yet for <strong>${focused.join(', ')}</strong>.
      Press <strong>&#9654;</strong> to start it, or <em>show all</em> to drop the filter.</p></div>`;
  }
  return `<div class="empty"><p>No logs yet. Start a service with <strong>&#9654;</strong>,
    or click a running one to focus just its output.</p></div>`;
}

/**
 * Appends a single new record without repainting the pane.
 * @param record - the log record
 */
function appendLog(record) {
  state.logs.push(record);
  state.bytes += record.bytes ?? 256;
  // Same FIFO budget the server keeps, so the tab cannot outgrow it either.
  while (state.bytes > BUFFER_BUDGET_BYTES && state.logs.length > 1) {
    state.bytes -= state.logs.shift().bytes ?? 256;
  }
  if (!passesFilters(record)) return;
  const last = visibleRecords[visibleRecords.length - 1];
  if (last && !last.member && sameLine(last.record, record) && !state.expanded.has(last.groupId)) {
    last.records.push(record);
    last.repeat += 1;
    last.record = record;
  } else {
    visibleRecords.push({ record, records: [record], repeat: 1, groupId: record.seq });
  }
  el.spacer.style.height = `${visibleRecords.length * ROW_HEIGHT}px`;
  el.count.textContent = `${visibleRecords.length} shown / ${state.logs.length} buffered`;
  if (state.follow) el.logs.scrollTop = el.logs.scrollHeight;
  schedulePaint();
}

/* ---------- detail ---------- */

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
      <h4>payload</h4>
      <button class="mini copy-btn" data-copy="${escapeHtml(raw)}">copy payload</button>
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

/**
 * Renders the detail pane for the selected log record.
 * @param record - the log record
 */
async function showDetail(record) {
  state.selected = record.seq;
  el.split.classList.add('detail-open');
  for (const row of el.window.querySelectorAll('.row.selected')) row.classList.remove('selected');
  el.window.querySelector(`.row[data-seq="${record.seq}"]`)?.classList.add('selected');

  el.detail.innerHTML = `<header><strong>${escapeHtml(record.service)}</strong>
      <span class="lvl ${record.level}">${record.level}</span>
      <span class="grow"></span>
      <button id="closeDetail">close</button>
    </header>
    <section>
      <div class="section-head">
        <h4>time</h4>
        <button class="mini copy-btn" data-copy="${formatExactTime(record.at)}">copy</button>
      </div>
      <pre class="exact-time">${formatExactTime(record.at)}<span class="iso">${new Date(record.at).toISOString()}</span></pre>
    </section>
    <section>
      <div class="section-head">
        <h4>message</h4>
        <button class="mini copy-btn" data-copy="${escapeHtml(record.msg)}">copy message</button>
      </div>
      <pre>${escapeHtml(record.msg)}</pre>
      ${correlationIds(record).length > 0 ? '<h4 style="margin-top:12px">ids</h4>' : ''}
      ${correlationIds(record)
        .map(
          (id) => `<div class="id-row">
            <code class="id-key">${escapeHtml(id.key)}</code>
            <span class="id-val" title="${escapeHtml(id.value)}">${escapeHtml(id.value)}</span>
            <button class="mini trace-btn" data-key="${escapeHtml(id.key)}" data-value="${escapeHtml(id.value)}"
              title="show every line carrying this ${escapeHtml(id.key)}">trace</button>
            <button class="mini copy-btn" data-copy="${escapeHtml(id.value)}">copy</button>
          </div>`,
        )
        .join('')}
    </section>
    <section id="originSection"><h4>origin</h4><div class="origin">resolving…</div></section>
    ${payloadSection(record.fields)}`;

  const origin = await post('/api/resolve', { msg: record.msg, context: record.context, service: record.service });
  const section = document.getElementById('originSection');
  if (!section) return;

  if (!origin.match) {
    const kind = foreignKind(record);
    section.innerHTML = `<h4>origin</h4>
      <div class="origin"><span class="badge ${kind ? 'foreign' : 'none'}">${kind ? 'not your code' : 'not found'}</span>
      <span>${kind ?? 'no indexed logger call matches this message'}</span></div>
      <div style="margin-top:8px"><button id="copyPrompt">copy Claude prompt</button></div>`;
  } else {
    const snippet = await post('/api/source', { file: origin.match.file, line: origin.match.line, radius: 10 });
    const code = snippet.lines
      .map((text, offset) => {
        const lineNumber = snippet.from + offset;
        const hit = lineNumber === origin.match.line ? ' class="hit"' : '';
        return `<div${hit}><span class="ln">${lineNumber}</span>${escapeHtml(text)}</div>`;
      })
      .join('');

    const others = (origin.candidates ?? []).filter(
      (candidate) => candidate.file !== origin.match.file || candidate.line !== origin.match.line,
    );
    section.innerHTML = `<h4>origin</h4>
      <div class="origin">
        <span class="badge ${origin.confidence}">${origin.confidence}</span>
        ${origin.match.kind === 'console' ? '<span class="badge temp">console.log — temporary debug</span>' : ''}
        ${origin.constant ? `<span class="badge">via ${escapeHtml(origin.constant)}</span>` : ''}
        <span class="path" id="openFile">${escapeHtml(origin.match.file)}:${origin.match.line}</span>
      </div>
      <div style="margin:8px 0"><button id="openBtn">open in VSCode</button>
        <button id="copyPrompt">copy Claude prompt</button></div>
      <div class="snippet">${code}</div>
      ${
        others.length > 0
          ? `<div class="candidates">
              <p>This exact message is logged from ${others.length + 1} places. It cannot be told
              apart from the line alone — the others are:</p>
              ${others
                .map(
                  (candidate) =>
                    `<div class="candidate"><span class="path candidate-open"
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

  for (const link of section.querySelectorAll('.candidate-open')) {
    link.addEventListener('click', () => post('/api/open', { file: link.dataset.file, line: Number(link.dataset.line) }));
  }
  const open = () => post('/api/open', { file: origin.match.file, line: origin.match.line });
  document.getElementById('openBtn')?.addEventListener('click', open);
  document.getElementById('openFile')?.addEventListener('click', open);
  document.getElementById('copyPrompt')?.addEventListener('click', async (event) => {
    await navigator.clipboard.writeText(buildPrompt(record, origin));
    event.target.textContent = 'copied ✓';
  });
  document.getElementById('closeDetail')?.addEventListener('click', () => {
    el.split.classList.remove('detail-open');
  });
  for (const button of document.querySelectorAll('.trace-btn')) {
    button.addEventListener('click', () => {
      // Tracing means "show me everything about this", so any text filter is dropped.
      state.trace = { key: button.dataset.key, value: button.dataset.value };
      state.search = '';
      el.search.value = '';
      state.follow = false;
      document.getElementById('follow').classList.remove('on');
      renderFocus();
      renderLogs();
    });
  }
}

/* ---------- wiring ---------- */

el.services.addEventListener('click', async (event) => {
  const node = event.target.closest('.service');
  if (!node) return;
  const name = node.dataset.name;
  const action = event.target.dataset?.act;

  if (action === 'restart') {
    if (!confirm(`Restart ${name}? The running process will be stopped first.`)) return;
    state.staleness[name] = { stale: false, changed: [] };
    renderServices();
    await post('/api/restart', { name });
    return;
  }
  if (action === 'stop') {
    await post('/api/stop', { name });
    state.staleness[name] = { stale: false, changed: [] };
    state.focus.delete(name);
    renderServices();
    renderFocus();
    renderLogs();
    return;
  }
  if (action === 'unmute') {
    state.muted.delete(name);
    await post('/api/mute', { name, muted: false });
    renderServices();
    return;
  }
  if (action === 'live') {
    state.focus.add(name);
    await startService(name, { live: true });
    renderServices();
    renderFocus();
    renderLogs();
    return;
  }
  if (action === 'start') {
    state.focus.add(name);
    await startService(name);
    renderServices();
    renderFocus();
    renderLogs();
    return;
  }

  // A plain click on the row focuses that service's logs; it never stops anything.
  if (state.focus.has(name)) state.focus.delete(name);
  else state.focus.add(name);
  renderServices();
  renderFocus();
  renderLogs();
});

/**
 * Renders the repository and footprint readout in the header.
 */
function renderStats() {
  const { git, devscope, services } = state.stats;
  const running = Object.keys(services ?? {}).length;
  const serviceTotal = Object.values(services ?? {}).reduce((sum, mb) => sum + mb, 0);

  document.getElementById('repoName').textContent = state.repo ?? '';

  const branch = document.getElementById('branchName');
  branch.innerHTML = git ? `<span class="glyph">&#9095;</span>${escapeHtml(git.branch)}` : '';
  branch.title = git ? `current branch — ${git.branch}` : '';

  const bits = [];
  if (git) {
    bits.push(`<span title="modified tracked files">${git.modified} modified</span>`);
    bits.push(`<span title="untracked files">${git.untracked} untracked</span>`);
  }
  if (running > 0) bits.push(`<span title="services running / their total memory">${running} up &middot; ${serviceTotal}MB</span>`);
  if (state.stats.bufferMaxMB) {
    bits.push(
      `<span title="log buffer — oldest lines are dropped once full">buffer ${state.stats.bufferMB}/${state.stats.bufferMaxMB}MB</span>`,
    );
  }
  if (devscope) bits.push(`<span title="devscope's own memory">devscope ${devscope}MB</span>`);
  document.getElementById('statsBar').innerHTML = bits.join('<span class="sep">|</span>');
}

/**
 * Renders the chips showing which services the log pane is focused on.
 */
function renderFocus() {
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

el.presets.addEventListener('click', async (event) => {
  if (event.target.id === 'savePreset') {
    const running = Object.entries(state.statuses)
      .filter(([, value]) => value.status === 'running')
      .map(([name]) => name);
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
    for (const name of state.presets[preset]) await startService(name);
  }
});

el.logs.addEventListener('click', (event) => {
  const badge = event.target.closest('.repeat');
  if (badge) {
    const groupId = Number(badge.dataset.group);
    const wasFollowing = state.follow;
    // Expanding inserts rows above the fold, so pin the clicked run in place.
    const anchor = { seq: groupId, offset: badge.closest('.row').getBoundingClientRect().top - el.logs.getBoundingClientRect().top };
    if (state.expanded.has(groupId)) state.expanded.delete(groupId);
    else state.expanded.add(groupId);
    // Following would drag the view straight back to the bottom.
    state.follow = false;
    renderLogs({ anchor });
    state.follow = wasFollowing && state.expanded.size === 0;
    document.getElementById('follow').classList.toggle('on', state.follow);
    return;
  }
  const row = event.target.closest('.row');
  if (!row) return;
  const record = state.logs.find((entry) => entry.seq === Number(row.dataset.seq));
  if (record) showDetail(record);
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

el.detail.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-btn');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    const original = button.textContent;
    button.textContent = 'copied ✓';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch {
    button.textContent = 'copy blocked';
  }
});

el.logs.addEventListener('scroll', schedulePaint, { passive: true });
window.addEventListener('resize', schedulePaint);

document.getElementById('follow').addEventListener('click', (event) => {
  state.follow = !state.follow;
  event.target.classList.toggle('on');
  if (state.follow) jumpToLatest();
});

document.getElementById('clear').addEventListener('click', () => {
  // Clears the view only. The buffer is kept so the lines can be brought back.
  state.hiddenBelow = state.logs.length === 0 ? 0 : state.logs[state.logs.length - 1].seq;
  renderLogs();
  renderRestore();
});

/**
 * Shows or hides the control that brings cleared lines back into view.
 */
function renderRestore() {
  const button = document.getElementById('restore');
  button.style.display = state.hiddenBelow > 0 ? 'inline-block' : 'none';
}

document.getElementById('restore').addEventListener('click', () => {
  state.hiddenBelow = 0;
  renderLogs();
  renderRestore();
});

document.getElementById('reindex').addEventListener('click', async (event) => {
  event.target.textContent = 'indexing…';
  const meta = await post('/api/reindex');
  el.indexMeta.textContent = `${meta.sites} log sites indexed`;
  event.target.textContent = 'reindex';
});

/* ---------- boot ---------- */

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
state.projects = initial.projects;
state.statuses = initial.statuses;
state.presets = initial.presets;
state.external = initial.external ?? {};
state.staleness = initial.staleness ?? {};
state.queued = initial.queued ?? [];
state.muted = new Set(initial.muted ?? []);
state.stats = initial.stats ?? { services: {}, git: null };
if (state.stats.bufferMaxMB) BUFFER_BUDGET_BYTES = state.stats.bufferMaxMB * 1024 * 1024;
state.repo = (initial.repoRoot ?? '').split('/').filter(Boolean).pop() ?? '';
document.getElementById('version').textContent = initial.version ? ` v${initial.version}` : '';
el.indexMeta.textContent = `${initial.index.sites} log sites indexed`;
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
  if (event.type === 'log') appendLog(event);
  if (event.type === 'status') {
    if (event.status === 'queued') {
      if (!state.queued.includes(event.service)) state.queued.push(event.service);
    } else {
      state.queued = state.queued.filter((name) => name !== event.service);
      state.statuses[event.service] = {
        status: event.status,
        pid: event.pid ?? null,
        confirmed: event.confirmed,
        reason: event.reason,
        ranForMs: event.ranForMs,
      };
      if (event.status === 'failed') {
        state.focus.add(event.service);
        renderFocus();
        renderLogs();
      }
    }
    renderServices();
  }
  if (event.type === 'external') {
    state.external = event.external;
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
    state.staleness[event.service] = { stale: true, changed: event.changed };
    renderServices();
  }
};


/* ---------- theme + resizable detail pane ---------- */

const themeSelect = document.getElementById('theme');
const storedTheme = (() => {
  try {
    return localStorage.getItem('devscope.theme');
  } catch {
    return null;
  }
})();

/**
 * Applies a colour theme and remembers it for next time.
 * @param name - the theme key
 */
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  themeSelect.value = name;
  try {
    localStorage.setItem('devscope.theme', name);
  } catch {
    // Private windows disallow storage; the theme simply will not persist.
  }
}

applyTheme(storedTheme ?? 'slate');
themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

const storedWidth = (() => {
  try {
    return Number(localStorage.getItem('devscope.detailWidth'));
  } catch {
    return 0;
  }
})();

/**
 * Sets the detail pane width and remembers it.
 * @param px - the desired width in pixels
 */
function setDetailWidth(px) {
  const clamped = Math.min(Math.max(px, 320), window.innerWidth - 360);
  el.split.style.setProperty('--detail-width', `${clamped}px`);
  try {
    localStorage.setItem('devscope.detailWidth', String(clamped));
  } catch {
    // Not persisting the width is harmless.
  }
}

if (storedWidth > 0) setDetailWidth(storedWidth);

document.getElementById('resizer').addEventListener('mousedown', (event) => {
  event.preventDefault();
  document.body.style.userSelect = 'none';
  const onMove = (move) => setDetailWidth(window.innerWidth - move.clientX);
  const onUp = () => {
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});


/* ---------- noise toggle, shortcuts, error jumping, persistence ---------- */

/**
 * Reads a remembered UI preference.
 * @param key - the preference name
 * @param fallback - value to use when nothing is stored
 * @returns the stored value, or the fallback
 */
function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`devscope.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Remembers a UI preference across reloads.
 * @param key - the preference name
 * @param value - the value to store
 */
function writePref(key, value) {
  try {
    localStorage.setItem(`devscope.${key}`, JSON.stringify(value));
  } catch {
    // Storage is unavailable in private windows; preferences simply reset.
  }
}

const noiseButton = document.getElementById('noise');

/**
 * Applies the noise setting to the button and the log pane.
 */
function applyNoise() {
  noiseButton.classList.toggle('on', state.showNoise);
  writePref('showNoise', state.showNoise);
  renderLogs();
}

noiseButton.addEventListener('click', () => {
  state.showNoise = !state.showNoise;
  applyNoise();
});

/**
 * Scrolls to the next or previous error/warning below or above the viewport.
 * @param direction - 1 to search forward, -1 to search back
 */
function jumpToError(direction) {
  const current = Math.round(el.logs.scrollTop / ROW_HEIGHT);
  const isProblem = (row) => row.record.level === 'error' || row.record.level === 'fatal';
  const range =
    direction > 0
      ? visibleRecords.slice(current + 1).findIndex(isProblem)
      : visibleRecords.slice(0, current).reverse().findIndex(isProblem);
  if (range === -1) return;
  const target = direction > 0 ? current + 1 + range : current - 1 - range;
  state.follow = false;
  document.getElementById('follow').classList.remove('on');
  el.logs.scrollTop = Math.max(0, target * ROW_HEIGHT - el.logs.clientHeight / 3);
  schedulePaint();
}

document.getElementById('nextError').addEventListener('click', () => jumpToError(1));

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
for (const level of readPref('hiddenLevels', [])) {
  state.levels.delete(level);
  document.querySelector(`.lvlFilter[data-level="${level}"]`)?.classList.remove('on');
}
for (const name of readPref('focus', [])) state.focus.add(name);

for (const button of document.querySelectorAll('.lvlFilter')) {
  button.addEventListener('click', () => {
    writePref('hiddenLevels', ['error', 'warn', 'info', 'debug', 'raw'].filter((l) => !state.levels.has(l)));
  });
}

el.services.addEventListener('click', () => writePref('focus', [...state.focus]));

applyNoise();
renderFocus();
renderServices();


/* ---------- settings panel (machine-level, stored server side) ---------- */

const settingsPanel = document.getElementById('settingsPanel');
const concurrencyInput = document.getElementById('concurrency');
const bufferInput = document.getElementById('bufferMB');
const muteInput = document.getElementById('muteFrontends');

/**
 * Fills the settings panel from the server's current settings.
 * @param settings - the settings as the server reports them
 */
function renderSettings(settings) {
  if (!settings) return;
  state.settings = settings;
  concurrencyInput.value = String(settings.resolvedConcurrency);
  document.getElementById('concurrencyValue').textContent = String(settings.resolvedConcurrency);
  document.getElementById('concurrencyHint').textContent =
    `Each start runs a webpack build. This machine suggests ${settings.recommended}` +
    `${settings.startConcurrency === null ? ' (in use, auto-detected)' : ''}.`;
  bufferInput.value = String(settings.bufferMB);
  document.getElementById('bufferValue').textContent = String(settings.bufferMB);
  muteInput.checked = settings.muteFrontends === true;
}

/**
 * Sends changed settings to the server, which owns and persists them.
 * @param changes - the fields to change
 */
async function pushSettings(changes) {
  renderSettings(await post('/api/settings', changes));
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});
document.getElementById('settingsClose').addEventListener('click', () => {
  settingsPanel.hidden = true;
});

concurrencyInput.addEventListener('input', () => {
  document.getElementById('concurrencyValue').textContent = concurrencyInput.value;
});
concurrencyInput.addEventListener('change', () => pushSettings({ startConcurrency: Number(concurrencyInput.value) }));

bufferInput.addEventListener('input', () => {
  document.getElementById('bufferValue').textContent = bufferInput.value;
});
bufferInput.addEventListener('change', () => pushSettings({ bufferMB: Number(bufferInput.value) }));

muteInput.addEventListener('change', () => pushSettings({ muteFrontends: muteInput.checked }));

renderSettings(initial.settings);


/* ---------- shortcut help, and the switch to turn them off ---------- */

const helpPanel = document.getElementById('helpPanel');
const shortcutsToggle = document.getElementById('shortcutsEnabled');
let shortcutsOn = readPref('shortcutsEnabled', true);
shortcutsToggle.checked = shortcutsOn;

shortcutsToggle.addEventListener('change', () => {
  shortcutsOn = shortcutsToggle.checked;
  writePref('shortcutsEnabled', shortcutsOn);
});

document.getElementById('helpBtn').addEventListener('click', () => {
  helpPanel.hidden = !helpPanel.hidden;
  settingsPanel.hidden = true;
});
document.getElementById('helpClose').addEventListener('click', () => {
  helpPanel.hidden = true;
});


document.getElementById('stopAll').addEventListener('click', async (event) => {
  const live = state.projects
    .map((project) => project.name)
    .filter((name) => ['running', 'starting', 'queued', 'external', 'failed'].includes(serviceState(name)));
  if (live.length === 0) return;
  if (!confirm(`Stop ${live.length} service(s)?\n\n${live.join(', ')}`)) return;
  event.target.textContent = 'stopping…';
  await post('/api/stop-all');
  for (const name of live) state.staleness[name] = { stale: false, changed: [] };
  renderServices();
});


/* ---------- resizable sidebar ---------- */

/**
 * Sets the sidebar width and remembers it for next time.
 * @param px - the desired width in pixels
 */
function setSidebarWidth(px) {
  const clamped = Math.min(Math.max(px, 180), Math.min(560, window.innerWidth - 320));
  document.body.style.setProperty('--sidebar-width', `${clamped}px`);
  writePref('sidebarWidth', clamped);
}

const storedSidebar = readPref('sidebarWidth', 0);
if (storedSidebar > 0) setSidebarWidth(storedSidebar);

document.getElementById('sidebarResizer').addEventListener('mousedown', (event) => {
  event.preventDefault();
  document.body.style.userSelect = 'none';
  const onMove = (move) => setSidebarWidth(move.clientX);
  const onUp = () => {
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});
