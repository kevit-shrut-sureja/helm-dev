#!/usr/bin/env node
// Service lifecycle, end to end, with nothing real in it: a throwaway workspace
// whose "services" are small Node scripts, run through the real runner, server and
// command line. It proves what the other checks cannot — that a restart waits for
// the old process to die, that a service that ignores SIGTERM is still stopped,
// that ports are learned from the sockets a service opens, and that `helmctl`
// reports all of it truthfully.
//
//   node lifecycle.mjs
//
// It never touches settings.json, the session record or a real repository, and it
// finishes in about twenty seconds.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Stands in for `npx nx serve <name>`: opens a debugger-style socket and announces
// it, then opens the "application" socket on a port it picks, logs that in pino's
// format, and keeps logging. A name starting `stubborn` ignores SIGTERM, which is
// what a service with a hung event loop does.
const FAKE_NPX = `#!/usr/bin/env node
const net = require('node:net');
const name = process.argv[4] ?? 'x';
const inspector = net.createServer().listen(0, '127.0.0.1', () => {
  process.stderr.write('Debugger listening on ws://127.0.0.1:' + inspector.address().port + '/fake\\n');
});
setTimeout(() => {
  const app = net.createServer().listen(0, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 30, time: Date.now(), context: 'Main', msg: 'Application is running on: http://127.0.0.1:' + app.address().port }));
  });
}, Number(process.env.FAKE_BOOT_MS ?? 1200));
setInterval(() => console.log(JSON.stringify({ level: 30, time: Date.now(), context: 'Tick', msg: name + ' heartbeat' })), 700);
setTimeout(() => console.error(JSON.stringify({ level: 50, time: Date.now(), context: 'Tick', msg: name + ' something broke' })), 1800);
process.on('SIGTERM', () => {
  if (name.startsWith('stubborn')) return;
  setTimeout(() => process.exit(0), 300);
});
`;

/**
 * Finds a port nothing is listening on.
 * @returns a free port number
 */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/**
 * Sleeps.
 * @param ms - milliseconds
 * @returns a promise that resolves afterwards
 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Checks whether a process exists.
 * @param pid - the process id
 * @returns true while it is alive
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const root = await mkdtemp(join(tmpdir(), 'helm-dev-lifecycle-'));
const workspace = join(root, 'ws');
await mkdir(join(root, 'bin'), { recursive: true });
await writeFile(join(root, 'bin', 'npx'), FAKE_NPX);
await chmod(join(root, 'bin', 'npx'), 0o755);
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'nx.json'), '{}');
for (const name of ['alpha', 'beta', 'stubborn']) {
  await mkdir(join(workspace, 'apps', name, 'src'), { recursive: true });
  await writeFile(
    join(workspace, 'apps', name, 'project.json'),
    JSON.stringify({ name, sourceRoot: `apps/${name}/src`, tags: ['type:app'], targets: { serve: { executor: '@nx/js:node' } } }),
  );
}
const settingsPath = join(root, 'settings.json');
await writeFile(settingsPath, JSON.stringify({ repos: [{ name: 'fake', path: workspace }], startConcurrency: 3, bufferMB: 10, muteFrontends: true }));

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    HELMDEV_PORT: String(PORT),
    HELMDEV_SETTINGS: settingsPath,
    HELMDEV_TAIL_DIR: join(root, 'tail'),
    HELMDEV_BUFFER_MB: '10',
    HELMDEV_DETECT_MS: '60000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
let serverExit = null;
server.on('exit', (code, signal) => (serverExit = `exited code=${code} signal=${signal}`));
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}\n`);
};

/**
 * Fetches from the throwaway server without keeping the connection. The test
 * blocks its own event loop while the command line runs, long enough for the
 * server to drop an idle connection that a pooled fetch would then reuse.
 * @param path - the route
 * @param init - fetch options
 * @returns the response
 */
const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { connection: 'close', ...init.headers } });

/**
 * Runs the command line against the throwaway server.
 * @param args - the helmctl arguments
 * @returns the exit status and output
 */
function ctl(...args) {
  const run = spawnSync(process.execPath, [join(HERE, 'cli.mjs'), '--port', String(PORT), ...args], { encoding: 'utf8', timeout: 90000 });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

/**
 * Reads one service's status record from the server.
 * @param name - the project name
 * @returns the record, or undefined
 */
async function statusOf(name) {
  const state = await (await api(`/api/state`)).json();
  return state.workspaces[0].statuses[name];
}

/**
 * Returns the highest log sequence number so far.
 * @returns the sequence number
 */
async function lastSeq() {
  const logs = await (await api(`/api/logs?limit=1`)).json();
  return logs[0]?.seq ?? 0;
}

try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server did not start:\n${serverLog}`);
    try {
      await api(`/api/state`);
      break;
    } catch {
      await sleep(200);
    }
  }

  let run = ctl('status');
  check('status with nothing running says so', run.code === 0 && /Nothing running/.test(run.out), run.out.trim().split('\n').pop());

  run = ctl('start', 'nope');
  check('an unknown service is a usage error', run.code === 2 && /No service called "nope"/.test(run.out), `exit ${run.code}`);

  /* ---- start: the port is learned from the sockets, not from any file ---- */
  run = ctl('start', 'alpha');
  const alpha = await statusOf('alpha');
  const announced = (await (await api(`/api/logs?service=alpha&grep=Application%20is%20running`)).json())[0]?.msg?.match(/:(\d+)$/)?.[1];
  check('start waits until the service is up', run.code === 0 && /alpha: running/.test(run.out), run.out.trim().split('\n').pop());
  // The log line can win the race against the 2s port check, so give the check its turn.
  let learned = false;
  for (let tries = 0; tries < 12 && !learned; tries += 1) {
    learned = (await statusOf('alpha')).ports?.length > 0;
    if (!learned) await sleep(500);
  }
  const ports = (await statusOf('alpha')).ports;
  check('its port is the one it opened, and the debugger port is left out', ports.length === 1 && String(ports[0]) === announced, `ports ${JSON.stringify(ports)}, announced ${announced}`);

  /* ---- logs ---- */
  run = ctl('logs', 'alpha', '-n', '5');
  check('logs prints recent lines for a service', run.code === 0 && /alpha heartbeat/.test(run.out) && /-- \d+ line/.test(run.out), `${run.out.trim().split('\n').length} lines`);
  run = ctl('logs', 'alpha', '--level', 'error');
  check('logs --level error keeps only errors', /something broke/.test(run.out) && !/heartbeat/.test(run.out));
  run = ctl('logs', 'alpha', '--grep', 'HEARTBEAT', '-n', '2');
  check('logs --grep is case-insensitive', (run.out.match(/heartbeat/g) ?? []).length === 2);
  run = ctl('logs', 'alpha', '--since', '1s');
  check('logs --since drops older lines', run.code === 0 && !/Application is running/.test(run.out), `${run.out.trim().split('\n').length} lines`);
  const before = await lastSeq();
  run = ctl('logs', 'alpha', '--follow', '--for', '3', '-n', '1');
  const seen = (run.out.match(/heartbeat/g) ?? []).length;
  check('logs --follow keeps printing, then stops by itself', seen >= 3 && (await lastSeq()) > before, `${seen} heartbeats`);

  /* ---- restart waits for the old process to be gone ---- */
  const oldPid = alpha.pid;
  run = ctl('restart', 'alpha');
  const renewed = await statusOf('alpha');
  check('restart brings up a new process', run.code === 0 && renewed.status === 'running' && renewed.pid !== oldPid, `${oldPid} → ${renewed.pid}`);
  check('the old process is gone by then', !alive(oldPid));

  /* ---- restart --all ---- */
  ctl('start', 'beta');
  const [pidA, pidB] = [(await statusOf('alpha')).pid, (await statusOf('beta')).pid];
  run = ctl('restart', '--all');
  const [nowA, nowB] = [await statusOf('alpha'), await statusOf('beta')];
  check('restart --all restarts every service that was up', run.code === 0 && nowA.pid !== pidA && nowB.pid !== pidB && nowA.status === 'running' && nowB.status === 'running', run.out.trim().split('\n').slice(-2).join(' | '));
  check('and leaves none of the old ones behind', !alive(pidA) && !alive(pidB));

  /* ---- a service that ignores SIGTERM is still stopped, then restarted ---- */
  ctl('start', 'stubborn');
  const stubbornPid = (await statusOf('stubborn')).pid;
  const began = Date.now();
  run = ctl('restart', 'stubborn');
  const waited = Date.now() - began;
  const reborn = await statusOf('stubborn');
  check('a service that ignores SIGTERM is killed after the grace period', !alive(stubbornPid) && waited >= 5500, `old pid dead, restart took ${(waited / 1000).toFixed(1)}s`);
  check('and only then started again', reborn.status === 'running' && reborn.pid !== stubbornPid, `${stubbornPid} → ${reborn.pid}`);

  /* ---- stop ---- */
  run = ctl('stop', 'alpha', 'beta');
  check('stop waits for them to be gone', run.code === 0 && (await statusOf('alpha')).status === 'stopped' && (await statusOf('beta')).status === 'stopped', run.out.trim().split('\n').pop());

  run = ctl('restart', '--all');
  check('restart --all with only a stubborn one still up restarts just it', run.code === 0 && /stubborn/.test(run.out) && !/alpha|beta/.test(run.out.replace(/helmctl.*/g, '')), run.out.trim().split('\n')[0]);

  run = ctl('status');
  check('status lists what is up', /fake\/stubborn\s+running/.test(run.out) && !/fake\/alpha/.test(run.out), run.out.trim().split('\n').pop());

  const nothing = await api(`/api/restart-all`, { method: 'POST', body: JSON.stringify({ repo: 'no-such-workspace' }) });
  check('restart-all for an unknown workspace is harmless', (await nothing.json()).restarting.length === 0);
} catch (error) {
  check('the run finished', false, error.message);
  process.stdout.write(`--- server ${serverExit ?? 'still running'} ---\n${serverLog.slice(-3000)}\n`);
} finally {
  // Everything the server started has its own process group, and a clean shutdown
  // would record this run as the session to resume — so stop them by hand.
  try {
    const state = await (await api(`/api/state`)).json();
    for (const entry of Object.values(state.workspaces[0].statuses)) {
      if (entry.pid) {
        try {
          process.kill(-entry.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  } catch {
    // The server never came up; nothing was started.
  }
  server.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
