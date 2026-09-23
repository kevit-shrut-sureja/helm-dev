import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const PINO_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

// Readiness must come from the application, not the build. `webpack compiled
// successfully` and `Debugger listening on` are emitted long before a service is
// up — and are still emitted by one that then dies on a missing env var.
const READY_APP = /(Nest application successfully started|Application is running on|Listening on port|started on port|Server is running on port)/i;
const READY_BUILD = /(Application bundle generation complete|Local:\s+http:\/\/)/i;
// Nx keeps a failed serve task alive, so a dead app must be spotted in its output.
const BOOT_FAILED = /(ExceptionHandler|Failed tasks|Nest application failed to start)/;
// Jobs end in whatever way their own code chooses, but they all run under
// `nx serve`, which reports the inner process's exit in one consistent line —
// and then stays alive waiting for changes, so no 'exit' event ever arrives.
const NX_PROCESS_EXIT = /Process exited with code (\d+)/;
const READY_FALLBACK_MS = 60000;

/**
 * Collects every descendant of a process. A process-group kill can miss a child
 * that started its own group, which then keeps holding the service's port.
 * @param root - the pid to walk down from
 * @returns the descendant pids, deepest last
 */
function descendantsOf(root) {
  let table = '';
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop();
    for (const child of children.get(pid) ?? []) {
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

/**
 * Splits a byte stream into complete lines, buffering any trailing partial line.
 * @param onLine - called with each complete line
 * @returns a function to feed chunks into
 */
function lineSplitter(onLine) {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length > 0) onLine(line);
    }
  };
}

const ANSI = /\u001b\[[0-9;]*m/g;
const NX_NOISE = /^(NX\s|>\s|Failed tasks|Hint:|-\s\S+:\S+|View structured, searchable error logs|Debugger listening|For help, see:|Nx read the output)/;
const NEST_LINE = /^\[Nest\]\s+\d+\s+-\s+.+?\s{2,}(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+(?:\[([^\]]+)\]\s+)?(.*)$/;
const NEST_LEVELS = { LOG: 'info', ERROR: 'error', WARN: 'warn', DEBUG: 'debug', VERBOSE: 'trace', FATAL: 'fatal' };
const PRETTY_LINE =
  /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))?:?\s*(.*)$/;
// pino-pretty prints `[2026-09-22 12:43:34.567]` in local time.
const PRETTY_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
// Nest prints `22/09/2026, 6:15:17 pm`.
const NEST_TIME = /(\d{1,2})\/(\d{1,2})\/(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(am|pm)?/i;

/**
 * Turns a printed local timestamp into epoch milliseconds, so a log carries the
 * moment the service logged it rather than the moment helm-dev read the pipe.
 * @param text - the timestamp as printed
 * @returns epoch milliseconds, or null when it is not a timestamp
 */
function parsePrintedTime(text) {
  if (typeof text !== 'string') return null;
  const pretty = PRETTY_TIME.exec(text.trim());
  if (pretty !== null) {
    const [, y, mo, d, h, mi, sec, ms] = pretty;
    return new Date(+y, +mo - 1, +d, +h, +mi, +sec, Number((ms ?? '0').padEnd(3, '0'))).getTime();
  }
  const nest = NEST_TIME.exec(text);
  if (nest !== null) {
    const [, d, mo, y, rawHour, mi, sec, ms, meridiem] = nest;
    let hour = Number(rawHour);
    if (meridiem?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (meridiem?.toLowerCase() === 'am' && hour === 12) hour = 0;
    return new Date(+y, +mo - 1, +d, hour, +mi, +sec, Number((ms ?? '0').padEnd(3, '0'))).getTime();
  }
  return null;
}

/**
 * Parses a pino-pretty formatted line, used when services are not emitting NDJSON.
 * @param text - the line with ANSI colours already stripped
 * @returns the level, context and message, or null when the line is not pretty-formatted
 */
function parsePretty(text) {
  const nest = NEST_LINE.exec(text.trim());
  if (nest !== null) {
    return {
      level: NEST_LEVELS[nest[1]],
      context: nest[2] ?? null,
      msg: nest[3],
      loggedAt: parsePrintedTime(text),
    };
  }
  const match = PRETTY_LINE.exec(text.trim());
  if (match === null) return null;
  const inside = match[3] ?? '';
  const context = /^\d+( on .+)?$/.test(inside) || inside.length === 0 ? null : inside.split(' on ')[0];
  return {
    level: match[1].toLowerCase(),
    context,
    msg: match[4],
    loggedAt: parsePrintedTime(match[2] ?? ''),
  };
}

/**
 * Normalises one output line into a log record, parsing pino NDJSON when present.
 * @param service - the emitting service name
 * @param stream - stdout or stderr
 * @param line - the raw output line
 * @returns the normalised record
 */
export function toRecord(service, stream, line) {
  const clean = line.replace(ANSI, '');
  const base = { service, stream, at: Date.now() };
  const trimmed = clean.trim();
  if (!trimmed.startsWith('{')) {
    const pretty = parsePretty(trimmed);
    if (pretty !== null) {
      const { loggedAt, ...rest } = pretty;
      return { ...base, ...rest, at: loggedAt ?? base.at, fields: null };
    }
    const level = stream === 'stderr' && !NX_NOISE.test(trimmed) ? 'error' : 'raw';
    return { ...base, level, msg: clean, context: null, fields: null };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const { level, msg, message, context, time, ...rest } = parsed;
    return {
      ...base,
      at: typeof time === 'number' ? time : base.at,
      level: PINO_LEVELS[level] ?? (typeof level === 'string' ? level : 'info'),
      msg: msg ?? message ?? '',
      context: context ?? null,
      fields: Object.keys(rest).length > 0 ? rest : null,
    };
  } catch {
    return { ...base, level: stream === 'stderr' ? 'error' : 'raw', msg: clean, context: null, fields: null };
  }
}

/**
 * Recognises the lines that explain why a service did not come up.
 * @param record - the parsed log record
 * @returns true when the line is worth quoting back as a failure reason
 */
function looksLikeFailure(record) {
  if (record.level === 'error' || record.level === 'fatal') return true;
  return /error TS\d+|Cannot find module|EADDRINUSE|is required|Failed tasks|ECONNREFUSED|MODULE_NOT_FOUND/i.test(record.msg);
}

/**
 * Decides whether a log record means the application itself is now serving.
 * @param record - the parsed log record
 * @returns true when the service can be considered up
 */
function isReady(record) {
  if (READY_BUILD.test(record.msg)) return true;
  return record.level !== 'raw' && READY_APP.test(record.msg);
}

/**
 * Merges pino-pretty continuation lines into the record they belong to.
 * @param record - the record parsed from the leading line
 * @param continuation - the indented lines that followed it
 * @returns the record enriched with its context and detail block
 */
export function finaliseRecord(record, continuation) {
  if (continuation.length === 0) return record;
  const block = continuation.join('\n');
  const context = record.context ?? /^\s*context:\s*"?([^"\n]+)"?/m.exec(block)?.[1] ?? null;
  const detail = continuation.filter((line) => !/^\s*context:/.test(line)).join('\n');
  return {
    ...record,
    context,
    fields: detail.trim().length > 0 ? { ...(record.fields ?? {}), detail } : record.fields,
  };
}

/**
 * Spawns and supervises `nx serve` processes, emitting their output as log records.
 */
export class ServiceRunner extends EventEmitter {
  #repoRoot;
  #processes = new Map();
  #pending = new Map();
  #queue = [];
  #booting = new Set();
  #concurrency = 1;
  #muted = new Set();
  #signalled = new Map();
  #startOptions = new Map();
  #recentErrors = new Map();

  constructor(repoRoot) {
    super();
    this.#repoRoot = repoRoot;
  }

  /**
   * Sets how many services may cold-start at the same time. Each start is a
   * webpack build, so the right number depends on the machine.
   * @param count - concurrent boots allowed, at least 1
   */
  setConcurrency(count) {
    this.#concurrency = Math.max(1, Math.floor(count));
    this.#pump();
  }

  /**
   * Reports the concurrency currently in force.
   * @returns the number of simultaneous boots allowed
   */
  concurrency() {
    return this.#concurrency;
  }

  /**
   * Stops a service's output being buffered or broadcast, without stopping the
   * service. Boot detection still runs, so its status stays accurate.
   * @param name - the project name
   * @param muted - true to drop its logs
   */
  setMuted(name, muted) {
    if (muted) this.#muted.add(name);
    else this.#muted.delete(name);
  }

  /**
   * Reports which services are currently dropping their logs.
   * @returns the muted service names
   */
  muted() {
    return [...this.#muted];
  }

  /**
   * Queues a service to start. Only one service boots at a time, because a
   * parallel cold start of several Nx builds will bring a laptop to its knees.
   * @param name - the project name
   * @returns true when the service was queued or started
   */
  enqueue(name, options = {}) {
    const status = this.#processes.get(name)?.status;
    if (status === 'running' || status === 'starting' || this.#queue.includes(name)) return false;
    this.#startOptions.set(name, { args: options.args ?? [], mode: options.mode ?? 'plain', kind: options.kind ?? 'app' });
    this.#queue.push(name);
    this.emit('status', { service: name, status: 'queued', position: this.#queue.length });
    this.#pump();
    return true;
  }

  /**
   * Removes a service from the start queue.
   * @param name - the project name
   * @returns true when it was queued
   */
  dequeue(name) {
    const at = this.#queue.indexOf(name);
    if (at === -1) return false;
    this.#queue.splice(at, 1);
    this.emit('status', { service: name, status: 'stopped' });
    return true;
  }

  /**
   * Starts the next queued service once the previous one has finished booting.
   */
  #pump() {
    while (this.#booting.size < this.#concurrency && this.#queue.length > 0) {
      const next = this.#queue.shift();
      this.#booting.add(next);
      this.start(next);
    }
  }

  /**
   * Releases the boot slot when a service finishes booting or dies.
   * @param name - the project name
   */
  #releaseSlot(name) {
    if (!this.#booting.delete(name)) return;
    this.#pump();
  }

  /**
   * Reports the services waiting to start, in order.
   * @returns the queued service names
   */
  queued() {
    return [...this.#queue];
  }

  /**
   * Emits a held record once no further continuation lines can belong to it.
   * @param key - the service and stream the record came from
   */
  #flush(key) {
    const held = this.#pending.get(key);
    if (!held) return;
    clearTimeout(held.timer);
    this.#pending.delete(key);
    if (this.#muted.has(held.record.service)) return;
    this.emit('log', finaliseRecord(held.record, held.continuation));
  }

  /**
   * Checks whether a pid belongs to a service helm-dev started, so evidence about
   * a port can be attributed to the right process.
   * @param name - the project name
   * @param pid - the pid found holding the port
   * @returns true when the pid is that service's, or one of its children
   */
  ownsPid(name, pid) {
    const entry = this.#processes.get(name);
    if (!entry || entry.child.pid === undefined || pid === null) return false;
    if (entry.child.pid === pid) return true;
    return descendantsOf(entry.child.pid).includes(pid);
  }

  /**
   * Confirms a service is up because it is listening on its port — evidence that
   * does not depend on what the application chose to print.
   * @param name - the project name
   * @param port - the port it was found listening on
   */
  confirmListening(name, port) {
    const entry = this.#processes.get(name);
    if (!entry || entry.status !== 'starting') return;
    entry.port = port;
    this.#markReady(name);
  }

  /**
   * Reports the pids helm-dev has signalled recently, so a process that has not
   * finished dying is not mistaken for one somebody else started.
   * @returns the pids signalled in the last 30 seconds
   */
  recentlySignalled() {
    const cutoff = Date.now() - 30000;
    for (const [pid, at] of this.#signalled) if (at < cutoff) this.#signalled.delete(pid);
    return new Set(this.#signalled.keys());
  }

  /**
   * Promotes a booting service to running, once its stack reports it is up.
   * @param name - the project name
   */
  #markReady(name, confirmed = true) {
    const entry = this.#processes.get(name);
    if (!entry || entry.status !== 'starting') return;
    clearTimeout(entry.readyTimer);
    this.#setStatus(name, 'running', { pid: entry.child.pid ?? null, confirmed });
    this.#releaseSlot(name);
  }

  /**
   * Handles the inner process ending while `nx serve` keeps running. A job that
   * exits cleanly has completed; anything else has failed. Either way the idle
   * wrapper is stopped, so it cannot silently re-run on the next file change.
   * @param name - the project name
   * @param code - the inner process's exit code
   */
  #finishInner(name, code) {
    const entry = this.#processes.get(name);
    if (!entry || entry.status === 'completed' || entry.status === 'failed') return;
    clearTimeout(entry.readyTimer);
    const ranForMs = Date.now() - entry.startedAt;

    if (code === 0) {
      this.#setStatus(name, 'completed', { code, ranForMs });
    } else if (code !== 0) {
      this.#setStatus(name, 'failed', { code, reason: this.failureReason(name), ranForMs });
    } else {
      this.#setStatus(name, 'stopped', { code, ranForMs });
    }
    this.#releaseSlot(name);

    const pid = entry.child.pid;
    if (pid === undefined) return;
    for (const child of descendantsOf(pid)) {
      try {
        process.kill(child, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      entry.child.kill('SIGTERM');
    }
  }

  /**
   * Flags a service whose process is alive but whose application failed to boot.
   * @param name - the project name
   * @param reason - the log line that revealed the failure
   */
  #markFailed(name, reason) {
    const entry = this.#processes.get(name);
    if (!entry || entry.status !== 'starting') return;
    clearTimeout(entry.readyTimer);
    this.#setStatus(name, 'failed', { reason });
    this.#releaseSlot(name);
  }

  /**
   * Returns the most useful recent error line for a service, for explaining a
   * failed start without making the reader go hunting.
   * @param name - the project name
   * @returns the error text, or null when nothing error-like was logged
   */
  failureReason(name) {
    const recent = this.#recentErrors.get(name) ?? [];
    if (recent.length === 0) return null;
    // "Failed tasks:" is Nx telling you it failed, not why. Prefer the line that
    // actually says what went wrong.
    const generic = /^(Failed tasks|Hint:|View structured|NX\s|-\s\S+:\S+$|>\s)/;
    const specific = [...recent].reverse().find((line) => !generic.test(line));
    return specific ?? recent[recent.length - 1];
  }

  /**
   * Buffers one output line, folding pino-pretty continuation lines into the record above them.
   * @param service - the emitting service name
   * @param stream - stdout or stderr
   * @param line - the raw output line
   */
  #ingest(service, stream, line) {
    const key = `${service}:${stream}`;
    const clean = line.replace(ANSI, '');

    if (/^\s/.test(clean) && this.#pending.has(key)) {
      this.#pending.get(key).continuation.push(clean);
      return;
    }

    this.#flush(key);
    const record = toRecord(service, stream, clean);
    const active = this.#processes.get(service);
    const exited = NX_PROCESS_EXIT.exec(record.msg);
    // For a long-running service this line means Nx is about to restart the inner
    // process, not that the service is done — only a job's exit is an ending.
    if (exited !== null && active && active.status !== 'stopping' && active.kind === 'job') {
      this.#finishInner(service, Number(exited[1]));
    }
    if (active?.status === 'starting') {
      if (isReady(record) || (active.kind === 'job' && record.level !== 'raw')) this.#markReady(service);
      else if (record.level === 'error' && BOOT_FAILED.test(`${record.context ?? ''} ${record.msg}`)) {
        this.#markFailed(service, record.msg);
      }
    }
    if (looksLikeFailure(record)) {
      const recent = this.#recentErrors.get(service) ?? [];
      recent.push(record.msg.trim());
      if (recent.length > 6) recent.shift();
      this.#recentErrors.set(service, recent);
    }
    if (this.#muted.has(service)) return;
    const held = { record, continuation: [], timer: setTimeout(() => this.#flush(key), 40) };
    this.#pending.set(key, held);
  }

  /**
   * Reports the current state of every service the runner has been asked to run.
   * @returns a map of service name to status
   */
  statuses() {
    const out = {};
    for (const [name, entry] of this.#processes) {
      out[name] = {
        status: entry.status,
        pid: entry.child.pid ?? null,
        startedAt: entry.startedAt,
        ranForMs: entry.ranForMs ?? null,
        // Kept on the entry so a page reload still explains a failed start.
        reason: entry.reason ?? null,
        exitCode: entry.exitCode ?? null,
        port: entry.port ?? null,
        mode: entry.mode ?? 'plain',
      };
    }
    return out;
  }

  #setStatus(name, status, extra) {
    const entry = this.#processes.get(name);
    if (entry) {
      entry.status = status;
      if (extra?.reason !== undefined) entry.reason = extra.reason;
      if (extra?.code !== undefined) entry.exitCode = extra.code;
      if (extra?.ranForMs !== undefined) entry.ranForMs = extra.ranForMs;
      if (status === 'starting') {
        entry.reason = null;
        entry.exitCode = null;
      }
    }
    this.emit('status', { service: name, status, ...extra });
  }

  /**
   * Starts a service via `nx serve`, unless it is already running.
   * @param name - the Nx project name
   * @returns true when a new process was spawned
   */
  start(name) {
    const existing = this.#processes.get(name);
    if (existing && ['running', 'starting', 'failed'].includes(existing.status)) return false;

    const startOptions = this.#startOptions.get(name) ?? { args: [], mode: 'plain' };
    const child = spawn('npx', ['nx', 'serve', name, '--output-style=stream-without-prefixes', ...startOptions.args], {
      cwd: this.#repoRoot,
      detached: true,
      env: { ...process.env, LOG_FORMAT: 'json', FORCE_COLOR: '0', NX_TUI: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.#recentErrors.delete(name);
    const entry = {
      child,
      status: 'starting',
      startedAt: Date.now(),
      readyTimer: null,
      mode: startOptions.mode,
      kind: startOptions.kind,
    };
    entry.readyTimer = setTimeout(() => this.#markReady(name, false), READY_FALLBACK_MS);
    this.#processes.set(name, entry);

    child.stdout.on('data', lineSplitter((line) => this.#ingest(name, 'stdout', line)));
    child.stderr.on('data', lineSplitter((line) => this.#ingest(name, 'stderr', line)));
    child.on('exit', (code, signal) => {
      clearTimeout(entry.readyTimer);
      // The inner process may already have decided the outcome, in which case
      // this exit is just the idle wrapper being cleaned up afterwards.
      if (entry.status === 'completed' || entry.status === 'failed') {
        this.#releaseSlot(name);
        return;
      }
      const cleanExit = code === 0;
      const stoppedByUs = entry.status === 'stopping';
      if (stoppedByUs) {
        this.#setStatus(name, 'stopped', { code, signal });
      } else if (entry.kind === 'job' && cleanExit) {
        // Workers are supposed to end. Finishing is a result, not a failure.
        this.#setStatus(name, 'completed', { code, ranForMs: Date.now() - entry.startedAt });
      } else if (!cleanExit || entry.status === 'starting') {
        this.#setStatus(name, 'failed', { code, signal, reason: this.failureReason(name) });
      } else {
        this.#setStatus(name, 'stopped', { code, signal });
      }
      this.#releaseSlot(name);
    });
    child.on('error', (error) => {
      this.#setStatus(name, 'stopped', { error: error.message });
      this.#releaseSlot(name);
    });

    this.#setStatus(name, 'starting', { pid: child.pid ?? null });
    return true;
  }

  /**
   * Stops a running service, killing the whole process group `nx serve` created.
   * @param name - the Nx project name
   * @returns true when a signal was delivered
   */
  stop(name) {
    if (this.dequeue(name)) return true;
    const entry = this.#processes.get(name);
    const liveStates = ['running', 'starting', 'failed'];
    if (!entry || !liveStates.includes(entry.status) || entry.child.pid === undefined) {
      return false;
    }
    clearTimeout(entry.readyTimer);
    // Signal the group, then every descendant by pid, so nothing survives to
    // hold the service's port and make the next start fail.
    const descendants = descendantsOf(entry.child.pid);
    const now = Date.now();
    this.#signalled.set(entry.child.pid, now);
    for (const pid of descendants) this.#signalled.set(pid, now);
    try {
      process.kill(-entry.child.pid, 'SIGTERM');
    } catch {
      entry.child.kill('SIGTERM');
    }
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone with its parent.
      }
    }
    this.#setStatus(name, 'stopping', {});
    this.#releaseSlot(name);
    return true;
  }

  /**
   * Stops every running service, used when the dashboard itself shuts down.
   * @returns the names of the services that were signalled
   */
  stopAll() {
    const stopped = [];
    for (const name of this.#processes.keys()) {
      if (this.stop(name)) stopped.push(name);
    }
    return stopped;
  }
}
