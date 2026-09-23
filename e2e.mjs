#!/usr/bin/env node
// End to end: starts a helm-dev of its own, exercises every route, pushes log
// lines through the real pipeline, fills the buffer until it evicts, boots the
// page's modules against it, and shuts it down.
//
//   node e2e.mjs
//
// It runs against whatever workspaces are configured in settings.json, so it
// tests this machine's actual setup. It writes nothing outside a temp directory:
// presets are read back and restored, and the buffer budget is overridden for
// the run rather than saved.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Waits until a condition is true, rather than guessing how long it takes. The
 * tail poll runs every 400ms and a burst has to clear it in more than one pass,
 * so a fixed sleep here is either wasted time or an occasional miss on a loaded
 * machine — this run flaked once on exactly that before the wait was made to
 * poll instead.
 * @param test - returns true once the condition holds
 * @param timeoutMs - how long to try before giving up
 * @returns whether the condition was met
 */
async function waitFor(test, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Finds a port nothing is listening on, so a running helm-dev is left alone.
 * @returns a free port number
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const TAIL = await mkdtemp(join(tmpdir(), 'helm-dev-e2e-'));

const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  cwd: HERE,
  env: {
    ...process.env,
    HELMDEV_PORT: String(PORT),
    HELMDEV_TAIL_DIR: TAIL,
    // `true` accepts any arguments and does nothing, so opening a file is
    // exercised without putting a window on someone's screen.
    HELMDEV_EDITOR: 'true {file}',
    // Small enough that a few thousand lines force the buffer to evict.
    HELMDEV_BUFFER_MB: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const deadline = Date.now() + 60000;
for (;;) {
  if (Date.now() > deadline) {
    process.stderr.write(`server did not start:\n${serverLog}\n`);
    server.kill('SIGKILL');
    process.exit(1);
  }
  try {
    await fetch(`${BASE}/api/state`);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}\n`);
};
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/* ---------- the SSE stream, read the way the page reads it ---------- */
const received = [];
let malformed = 0;
const stream = await fetch(`${BASE}/api/events`);
const reader = stream.body.getReader();
(async () => {
  const decode = new TextDecoder();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    carry += decode.decode(value, { stream: true });
    const frames = carry.split('\n\n');
    carry = frames.pop() ?? '';
    for (const frame of frames) {
      if (frame.startsWith(': ')) continue;
      if (!frame.startsWith('data: ')) { malformed += 1; continue; }
      try { received.push(JSON.parse(frame.slice(6))); } catch { malformed += 1; }
    }
  }
})().catch(() => undefined);

/* ---------- routes ---------- */
const state = await (await fetch(`${BASE}/api/state`)).json();
check('GET /api/state', Array.isArray(state.workspaces) && state.workspaces.length > 0,
  `${state.workspaces.length} workspaces, v${state.version}`);
check('projects discovered', state.workspaces.every((w) => w.projects.length > 0),
  state.workspaces.map((w) => `${w.name}:${w.projects.length}`).join(' '));

const logs = await (await fetch(`${BASE}/api/logs?limit=10`)).json();
check('GET /api/logs', Array.isArray(logs));

const resolved = await post('/api/resolve', {
  repo: 'chatomate', msg: 'Something went wrong while fetching bot usage analytics',
  context: 'ExceptionsHandler', service: 'platform-apis',
});
check('POST /api/resolve finds source', resolved.body?.match?.file?.endsWith('.ts') === true,
  `${resolved.body?.match?.file}:${resolved.body?.match?.line} (${resolved.body?.confidence})`);

const source = await post('/api/source', { repo: 'chatomate', file: resolved.body?.match?.file, line: resolved.body?.match?.line, radius: 2 });
check('POST /api/source reads it', Array.isArray(source.body?.lines) && source.body.lines.length > 0,
  `${source.body?.lines?.length} lines from ${source.body?.from}`);

const escape = await post('/api/source', { file: '../../etc/passwd', line: 1 });
check('POST /api/source rejects escapes', escape.status === 400, escape.body?.error);

const opened = await post('/api/open', { repo: 'chatomate', file: 'package.json', line: 1 });
check('POST /api/open launches the editor', opened.body?.opened === true, `via ${opened.body?.via}`);

const settings = await post('/api/settings', {});
check('POST /api/settings', typeof settings.body?.bufferMB === 'number', `buffer ${settings.body?.bufferMB}MB`);

const savedPresets = state.presets ?? {};
const presets = await post('/api/presets', { ...savedPresets, __e2e: ['platform'] });
check('POST /api/presets', presets.body?.saved === true);
await post('/api/presets', savedPresets);

const reindex = await post('/api/reindex', { repo: 'chatomate' });
check('POST /api/reindex is per workspace', typeof reindex.body?.chatomate?.sites === 'number',
  `${reindex.body?.chatomate?.sites} sites`);

const bogus = await post('/api/start', { repo: 'chatomate', name: 'no-such-service-xyz' });
check('POST /api/start refuses an unknown service', bogus.status >= 400 || bogus.body?.started === false,
  `status ${bogus.status} ${JSON.stringify(bogus.body)?.slice(0, 40)}`);

const stopAll = await post('/api/stop-all', {});
check('POST /api/stop-all with nothing running', stopAll.status === 200);

const missing = await fetch(`${BASE}/api/nope`, { method: 'POST' });
check('unknown route 404s', missing.status === 404);

/* ---------- the log pipeline, through a tailed drop file ---------- */
await mkdir(TAIL, { recursive: true });
const before = received.length;
const BURST = 400;
const lines = Array.from({ length: BURST }, (_, i) =>
  JSON.stringify({ level: 30, time: Date.now(), msg: `e2e synthetic ${i}`, context: 'E2E', reqId: `req-${i}` }),
).join('\n');
await appendFile(`${TAIL}/platform.log`, `${lines}\n`);
await waitFor(() => received.slice(before).filter((e) => e.type === 'log' && e.msg?.startsWith('e2e synthetic')).length >= BURST);

const logEvents = received.slice(before).filter((e) => e.type === 'log' && e.msg?.startsWith('e2e synthetic'));
check('tailed lines reach the SSE stream', logEvents.length === BURST, `${logEvents.length}/${BURST} received`);
check('frames are well formed', malformed === 0, `${malformed} malformed`);
check('ordered by a single sequence', logEvents.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq));
// "platform" exists in both workspaces, so a tailed file of that name cannot be
// attributed to either — the rule is exactly one owner or none.
check('an ambiguous name is left unattributed', logEvents.every((e) => e.repo === undefined), `repo=${logEvents[0]?.repo}`);

const only = state.workspaces[0].projects
  .map((p) => p.name)
  .find((name) => state.workspaces.filter((w) => w.projects.some((p) => p.name === name)).length === 1);
const mark = received.length;
await appendFile(`${TAIL}/${only}.log`, `${JSON.stringify({ level: 30, time: Date.now(), msg: 'e2e unique owner' })}\n`);
await waitFor(() => received.slice(mark).some((e) => e.msg === 'e2e unique owner'));
const owned = received.slice(mark).find((e) => e.msg === 'e2e unique owner');
check('a name unique to one workspace is attributed', owned?.repo === state.workspaces[0].name,
  `${only} → ${owned?.repo}`);

const backlog = await (await fetch(`${BASE}/api/logs?limit=50`)).json();
check('the backlog carries each record size', backlog.every((e) => typeof e.bytes === 'number' && e.bytes > 0),
  `first ${backlog[0]?.bytes} bytes`);

/* ---------- eviction under a deliberately tiny budget ---------- */
const fat = Array.from({ length: 3000 }, (_, i) =>
  JSON.stringify({ level: 30, time: Date.now(), msg: `e2e fat ${i}`, context: 'E2E', detail: 'x'.repeat(400) }),
).join('\n');
await appendFile(`${TAIL}/platform.log`, `${fat}\n`);
// stats.bufferMB is refreshed on an 8s tick, not per line — it is what the header
// shows, not a live read. The buffer itself is live on every request, so eviction
// is watched through /api/logs, the same endpoint the oldest-line check below uses.
await waitFor(async () => {
  const probe = await (await fetch(`${BASE}/api/logs?limit=100000`)).json();
  return probe.length > 0 && probe[0].seq > logEvents[0].seq;
}, 15000);

const kept = await (await fetch(`${BASE}/api/logs?limit=100000`)).json();
check('oldest lines went first', kept.length > 0 && logEvents.length > 0 && kept[0].seq > logEvents[0].seq,
  `oldest kept seq ${kept[0]?.seq}, first sent ${logEvents[0]?.seq}`);
check('buffer evicted rather than grew', kept.length < 3400, `${kept.length} records held`);

const after = await (await fetch(`${BASE}/api/state`)).json();
check('buffer stays inside its budget', after.stats.bufferMB <= after.stats.bufferMaxMB,
  `${after.stats.bufferMB}MB of ${after.stats.bufferMaxMB}MB`);

reader.cancel().catch(() => undefined);

/* ---------- the page's own modules, booted against this instance ---------- */

const smoke = spawn(process.execPath, [join(HERE, 'smoke.mjs')], {
  env: { ...process.env, HELMDEV_URL: BASE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let smokeOut = '';
smoke.stdout.on('data', (chunk) => { smokeOut += chunk; });
smoke.stderr.on('data', (chunk) => { smokeOut += chunk; });
const smokeCode = await new Promise((resolve) => smoke.on('exit', resolve));
let rows = 0;
try { rows = JSON.parse(smokeOut).serviceRows; } catch { rows = 0; }
check('the page boots and renders against it', smokeCode === 0 && rows > 0, `${rows} service rows`);

// SIGKILL: a clean shutdown would record this throwaway run as the session to
// resume, over whatever the real instance last wrote.
server.kill('SIGKILL');

const failed = results.filter((result) => !result.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
