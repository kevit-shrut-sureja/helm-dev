// Command-line control of a running helm-dev: see what is up, start, stop and
// restart services, and read their logs. Written for people and for AI
// assistants alike — every command prints something short enough to read whole,
// ends with a line saying what happened, and exits non-zero when it did not work.
//
// It is only a client. Everything it does goes through the same HTTP routes the
// page uses, so there is one place that knows how to run a service.

const DEFAULT_PORT = 7788;
const WAIT_POLL_MS = 1000;
const DEFAULT_WAIT_S = 180;
const DEFAULT_LINES = 100;
const MAX_LINES = 5000;
const MESSAGE_CHARS = 400;

const VALUE_FLAGS = new Set(['repo', 'lines', 'level', 'grep', 'since', 'timeout', 'port', 'for', 'context']);

const HELP = `helmctl — control a running helm-dev

  helmctl status [service] [--all] [--json]
        What is running. Stopped services are hidden unless --all.
  helmctl start <service...> [--live] [--force] [--no-wait]
  helmctl stop <service...> [--no-wait]
  helmctl restart <service...> | --all  [--no-wait]
        Waits until the service is up (or has failed, with the reason).
  helmctl logs [service] [-n 100] [--level error,warn] [--grep text]
               [--since 10m] [--follow [--for 30]] [--fields] [--full] [--json]
        Newest lines last. --grep also searches structured fields.
  helmctl resolve <service> "<log message>" [--context ClassName]
        Which source file and line printed that message.

A service is "name", or "repo/name" when the same name exists in two workspaces
(or pass --repo). --port or HELMDEV_PORT picks the server (default ${DEFAULT_PORT}).
Exit status: 0 done, 1 a service failed or timed out, 2 bad usage or no server.`;

/**
 * Splits the command line into positional words and flags, without a library.
 * @param argv - the arguments after the command name
 * @returns the positional words and a map of flags
 */
function parseArgs(argv) {
  const words = [];
  const flags = {};
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '-n') {
      flags.lines = argv[(at += 1)];
    } else if (arg === '-f') {
      flags.follow = true;
    } else if (arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      flags[name] = VALUE_FLAGS.has(name) ? (inline ?? argv[(at += 1)]) : true;
    } else {
      words.push(arg);
    }
  }
  return { words, flags };
}

/**
 * Prints a message to stderr and ends the process.
 * @param code - the exit status
 * @param message - what to tell the caller
 */
function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * Calls the helm-dev server.
 * @param base - the server's base URL
 * @param path - the route, with any query string
 * @param body - a JSON body, which makes it a POST
 * @returns the status and parsed body
 */
async function call(base, path, body) {
  let response;
  try {
    response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    die(2, `helm-dev is not running at ${base}. Start it with ./helm-dev, or pass --port.`);
  }
  const parsed = await response.json().catch(() => null);
  if (response.status === 404 && parsed === null) {
    die(2, `${path} is not served — the running helm-dev is older than this command. Restart it.`);
  }
  return { status: response.status, body: parsed };
}

/**
 * Turns "5m", "2h" or a date into the moment it names.
 * @param text - the value after --since
 * @returns epoch milliseconds
 */
function parseSince(text) {
  const relative = /^(\d+)\s*([smhd])$/.exec(text);
  if (relative) return Date.now() - Number(relative[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[relative[2]];
  const absolute = Date.parse(text);
  if (Number.isNaN(absolute)) die(2, `Cannot read --since "${text}". Use 30s, 10m, 2h, or a date.`);
  return absolute;
}

/**
 * Formats how long a service has been up.
 * @param startedAt - epoch milliseconds, or null
 * @returns a short duration, or an empty string
 */
function uptime(startedAt) {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Reads a service's current state out of the server's state snapshot.
 * @param workspace - one workspace from /api/state
 * @param name - the project name
 * @returns the status plus the facts that go with it
 */
function stateOf(workspace, name) {
  const entry = workspace.statuses[name];
  const external = workspace.external[name];
  let status = entry?.status ?? 'stopped';
  if (status === 'stopped' && workspace.queued.includes(name)) status = 'queued';
  if (status === 'stopped' && external) status = 'external';
  return { status, entry: entry ?? null };
}

/**
 * Finds the one project a name refers to, across every open workspace.
 * @param snapshot - the /api/state body
 * @param arg - "name" or "repo/name"
 * @param repoFlag - the --repo flag, if given
 * @returns the workspace and project
 */
function findService(snapshot, arg, repoFlag) {
  let repo = repoFlag;
  let name = arg;
  const slash = arg.indexOf('/');
  if (slash > 0 && snapshot.workspaces.some((workspace) => workspace.name === arg.slice(0, slash))) {
    repo = arg.slice(0, slash);
    name = arg.slice(slash + 1);
  }
  const matches = [];
  for (const workspace of snapshot.workspaces) {
    if (repo && workspace.name !== repo) continue;
    const project = workspace.projects.find((candidate) => candidate.name === name);
    if (project) matches.push({ workspace, project });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    die(2, `No service called "${arg}"${repo ? ` in ${repo}` : ''}. \`helmctl status --all\` lists them.`);
  }
  die(2, `"${arg}" exists in ${matches.map((match) => match.workspace.name).join(' and ')}. Say which: ${matches[0].workspace.name}/${name}`);
}

/**
 * Describes where a service stands, in one line.
 * @param label - repo/name
 * @param status - the service's state
 * @param entry - its status record
 * @returns the line to print
 */
function describe(label, status, entry) {
  const ports = entry?.ports?.length > 0 ? ` on ${entry.ports.map((port) => `:${port}`).join(' ')}` : '';
  if (status === 'running') {
    const note = entry?.confirmed === false ? ' (assumed up; not seen listening)' : '';
    return `${label}: running${ports} · up ${uptime(entry?.startedAt)}${note}`;
  }
  if (status === 'failed') {
    return `${label}: FAILED${entry?.exitCode !== null && entry?.exitCode !== undefined ? ` (exit ${entry.exitCode})` : ''} — ${
      entry?.reason ?? 'no reason captured; see its logs'
    }`;
  }
  return `${label}: ${status}`;
}

/**
 * Waits for services to reach a state worth reporting, by watching the server.
 * A restart is told apart from the old process by its start time: the old one
 * still reads "running" for a moment after the command is given.
 * @param base - the server's base URL
 * @param targets - { repo, name, since } for each service to follow, `since` being its start time before the command
 * @param seconds - how long to wait in all
 * @returns how many failed or were still not up when time ran out
 */
async function waitFor(base, targets, seconds) {
  const pending = new Map(targets.map((target) => [`${target.repo}/${target.name}`, target]));
  const deadline = Date.now() + seconds * 1000;
  let bad = 0;
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((later) => setTimeout(later, WAIT_POLL_MS));
    const { body: snapshot } = await call(base, '/api/state');
    for (const [label, target] of pending) {
      const workspace = snapshot.workspaces.find((candidate) => candidate.name === target.repo);
      const { status, entry } = stateOf(workspace, target.name);
      const fresh = entry !== null && entry.startedAt !== target.since;
      if (target.stopping ? ['stopped', 'failed', 'completed'].includes(status) : fresh && ['running', 'failed', 'completed', 'stopped'].includes(status)) {
        console.log(describe(label, status, entry));
        if (status === 'failed') {
          console.log(`  → helmctl logs ${label} --level error,warn -n 30`);
          bad += 1;
        }
        pending.delete(label);
      }
    }
  }
  for (const [label, target] of pending) {
    const { body: snapshot } = await call(base, '/api/state');
    const workspace = snapshot.workspaces.find((candidate) => candidate.name === target.repo);
    console.log(`${label}: still ${stateOf(workspace, target.name).status} after ${seconds}s — gave up waiting (it may yet come up)`);
    bad += 1;
  }
  return bad;
}

/**
 * Prints what is running.
 * @param base - the server's base URL
 * @param words - optional service names
 * @param flags - the parsed flags
 */
async function statusCommand(base, words, flags) {
  const { body: snapshot } = await call(base, '/api/state');
  const chosen = words.map((word) => findService(snapshot, word, flags.repo));
  const rows = [];
  const counts = {};
  for (const workspace of snapshot.workspaces) {
    if (flags.repo && workspace.name !== flags.repo) continue;
    for (const project of workspace.projects) {
      const { status, entry } = stateOf(workspace, project.name);
      counts[status] = (counts[status] ?? 0) + 1;
      if (chosen.length > 0 && !chosen.some((one) => one.project === project)) continue;
      if (chosen.length === 0 && status === 'stopped' && !flags.all) continue;
      rows.push({
        service: `${workspace.name}/${project.name}`,
        kind: project.kind,
        status,
        ports: entry?.ports ?? [],
        pid: entry?.pid ?? null,
        startedAt: entry?.startedAt && ['running', 'starting'].includes(status) ? entry.startedAt : null,
        reason: status === 'failed' ? (entry?.reason ?? null) : null,
        confirmed: entry?.confirmed ?? null,
      });
    }
  }
  if (flags.json) {
    console.log(JSON.stringify(rows.map(({ startedAt, ...row }) => ({ ...row, upMs: startedAt ? Date.now() - startedAt : null }))));
    return;
  }
  const width = Math.max(7, ...rows.map((row) => row.service.length));
  for (const row of rows) {
    const note = row.reason ? `  ${row.reason.slice(0, 120)}` : row.status === 'running' && row.confirmed === false ? '  (assumed up)' : '';
    console.log(
      `${row.service.padEnd(width)}  ${row.status.padEnd(9)} ${row.kind.padEnd(8)} ${row.ports.map((port) => `:${port}`).join(' ').padEnd(12)} ${uptime(row.startedAt).padEnd(5)}${note}`,
    );
  }
  const summary = ['running', 'starting', 'queued', 'failed', 'external', 'stopping', 'completed']
    .filter((name) => counts[name])
    .map((name) => `${counts[name]} ${name}`);
  console.log(`${rows.length === 0 ? 'Nothing running. ' : ''}${summary.join(' · ')}${counts.stopped ? ` · ${counts.stopped} stopped` : ''}`);
}

/**
 * Starts services and waits for them to come up.
 * @param base - the server's base URL
 * @param words - the service names
 * @param flags - the parsed flags
 * @returns the number that did not come up
 */
async function startCommand(base, words, flags) {
  if (words.length === 0) die(2, 'Usage: helmctl start <service...>');
  const { body: snapshot } = await call(base, '/api/state');
  const targets = [];
  let bad = 0;
  for (const word of words) {
    const { workspace, project } = findService(snapshot, word, flags.repo);
    const label = `${workspace.name}/${project.name}`;
    const before = workspace.statuses[project.name]?.startedAt;
    if (stateOf(workspace, project.name).status === 'failed') {
      console.log(`${label}: is in a failed state — \`helmctl restart ${label}\` clears it and starts again`);
      bad += 1;
      continue;
    }
    const { status, body } = await call(base, '/api/start', { repo: workspace.name, name: project.name, live: flags.live === true, force: flags.force === true });
    if (status === 409) {
      console.log(`${label}: not started — ${body.warnings.map((warning) => warning.message).join(' ')} Use --force to start anyway.`);
      bad += 1;
    } else if (status >= 400) {
      console.log(`${label}: ${body?.error ?? `refused (${status})`}`);
      bad += 1;
    } else if (body.queued === false) {
      const { status: now, entry } = stateOf(workspace, project.name);
      console.log(`${label}: already ${now}${entry?.ports?.length ? ` on :${entry.ports.join(' :')}` : ''}`);
    } else {
      console.log(`${label}: ${body.position > 1 ? `queued (${body.position})` : 'starting'}…`);
      targets.push({ repo: workspace.name, name: project.name, since: before });
    }
  }
  if (flags['no-wait'] || targets.length === 0) return bad;
  return bad + (await waitFor(base, targets, Number(flags.timeout) || DEFAULT_WAIT_S));
}

/**
 * Stops services.
 * @param base - the server's base URL
 * @param words - the service names
 * @param flags - the parsed flags
 * @returns the number that did not stop
 */
async function stopCommand(base, words, flags) {
  if (words.length === 0) die(2, 'Usage: helmctl stop <service...>');
  const { body: snapshot } = await call(base, '/api/state');
  const targets = [];
  for (const word of words) {
    const { workspace, project } = findService(snapshot, word, flags.repo);
    const label = `${workspace.name}/${project.name}`;
    const { body } = await call(base, '/api/stop', { repo: workspace.name, name: project.name });
    if (!body.stopped) console.log(`${label}: was not running`);
    else if (body.wasExternal) console.log(`${label}: stopped (it was started outside helm-dev)`);
    else targets.push({ repo: workspace.name, name: project.name, stopping: true });
  }
  if (flags['no-wait'] || targets.length === 0) return 0;
  return waitFor(base, targets, 30);
}

/**
 * Restarts services, or every one that is up.
 * @param base - the server's base URL
 * @param words - the service names
 * @param flags - the parsed flags
 * @returns the number that did not come back up
 */
async function restartCommand(base, words, flags) {
  if (words.length === 0 && !flags.all) die(2, 'Usage: helmctl restart <service...>  or  helmctl restart --all');
  const { body: snapshot } = await call(base, '/api/state');
  const targets = [];

  if (flags.all) {
    for (const workspace of snapshot.workspaces) {
      if (flags.repo && workspace.name !== flags.repo) continue;
      for (const [name, entry] of Object.entries(workspace.statuses)) {
        if (['running', 'starting'].includes(entry.status)) targets.push({ repo: workspace.name, name, since: entry.startedAt });
      }
    }
    if (targets.length === 0) {
      console.log('Nothing is running, so nothing to restart.');
      return 0;
    }
    await call(base, '/api/restart-all', { repo: flags.repo });
  } else {
    for (const word of words) {
      const { workspace, project } = findService(snapshot, word, flags.repo);
      const entry = workspace.statuses[project.name];
      targets.push({ repo: workspace.name, name: project.name, since: entry?.startedAt });
      await call(base, '/api/restart', { repo: workspace.name, name: project.name });
    }
  }
  console.log(`Restarting ${targets.map((target) => `${target.repo}/${target.name}`).join(', ')}…`);
  if (flags['no-wait']) return 0;
  return waitFor(base, targets, Number(flags.timeout) || DEFAULT_WAIT_S);
}

/**
 * Formats one log record as a line.
 * @param record - a record from /api/logs
 * @param flags - the parsed flags
 * @returns the line
 */
function formatRecord(record, flags) {
  const time = new Date(record.at);
  const stamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}.${String(
    time.getMilliseconds(),
  ).padStart(3, '0')}`;
  let message = String(record.msg ?? '').replace(/\s*\n\s*/g, ' ⏎ ');
  if (!flags.full && message.length > MESSAGE_CHARS) message = `${message.slice(0, MESSAGE_CHARS)}… (${record.msg.length} chars; --full)`;
  const detail = flags.fields && record.fields ? ` ${JSON.stringify(record.fields).slice(0, flags.full ? undefined : MESSAGE_CHARS)}` : '';
  return `${stamp} ${record.repo ? `${record.repo}/` : ''}${record.service} ${String(record.level).toUpperCase().padEnd(5)}${
    record.context ? ` [${record.context}]` : ''
  } ${message}${detail}`;
}

/**
 * Prints log lines, once or as they arrive.
 * @param base - the server's base URL
 * @param words - an optional service name
 * @param flags - the parsed flags
 */
async function logsCommand(base, words, flags) {
  const query = new URLSearchParams();
  if (words[0]) {
    const { body: snapshot } = await call(base, '/api/state');
    const { workspace, project } = findService(snapshot, words[0], flags.repo);
    query.set('repo', workspace.name);
    query.set('service', project.name);
  } else if (flags.repo) {
    query.set('repo', flags.repo);
  }
  if (flags.level) query.set('level', flags.level);
  if (flags.grep) query.set('grep', flags.grep);
  if (flags.since) query.set('since', String(parseSince(flags.since)));
  const limit = Math.min(Number(flags.lines) || DEFAULT_LINES, MAX_LINES);
  query.set('limit', String(limit));

  const { body: records } = await call(base, `/api/logs?${query}`);
  const print = (record) => console.log(flags.json ? JSON.stringify({ ...record, bytes: undefined, type: undefined }) : formatRecord(record, flags));
  for (const record of records) print(record);
  if (!flags.follow) {
    if (!flags.json) {
      console.log(
        records.length === 0
          ? 'No matching lines in the buffer (it only holds recent output; has the service been started?).'
          : `-- ${records.length} line(s)${records.length === limit ? ` — more exist, use -n or narrow with --since/--level/--grep` : ''}`,
      );
    }
    return;
  }

  let last = records.length > 0 ? records[records.length - 1].seq : 0;
  if (last === 0) {
    // Nothing matched yet, so follow from "now", not from the start of the buffer.
    const { body: newest } = await call(base, '/api/logs?limit=1');
    last = newest[0]?.seq ?? 0;
  }
  const stopAt = Number(flags.for ?? 30) === 0 ? Infinity : Date.now() + Number(flags.for ?? 30) * 1000;
  while (Date.now() < stopAt) {
    await new Promise((later) => setTimeout(later, WAIT_POLL_MS));
    query.set('after', String(last));
    query.set('limit', '2000');
    const { body: fresh } = await call(base, `/api/logs?${query}`);
    for (const record of fresh) print(record);
    if (fresh.length > 0) last = fresh[fresh.length - 1].seq;
    else {
      // Records that did not match still moved the sequence on; skip past them.
      const { body: newest } = await call(base, '/api/logs?limit=1');
      last = Math.max(last, newest[0]?.seq ?? last);
    }
  }
}

/**
 * Finds the source line behind a log message.
 * @param base - the server's base URL
 * @param words - the service and the message
 * @param flags - the parsed flags
 */
async function resolveCommand(base, words, flags) {
  if (words.length < 2) die(2, 'Usage: helmctl resolve <service> "<log message>"');
  const { body: snapshot } = await call(base, '/api/state');
  const { workspace, project } = findService(snapshot, words[0], flags.repo);
  const { body: result } = await call(base, '/api/resolve', {
    repo: workspace.name,
    service: project.name,
    msg: words.slice(1).join(' '),
    context: flags.context ?? null,
  });
  if (!result.match) {
    console.log('No source line found for that message in this service (or its shared libs).');
    return;
  }
  const { match } = result;
  console.log(`${match.file}:${match.line}  (${result.confidence}${match.class ? `, ${match.class}.${match.method}` : ''})`);
  for (const other of result.candidates.slice(1, 5)) console.log(`  also: ${other.file}:${other.line}${other.class ? ` (${other.class})` : ''}`);
}

const { words, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = words;
const base = `http://127.0.0.1:${Number(flags.port ?? process.env.HELMDEV_PORT) || DEFAULT_PORT}`;
const commands = { status: statusCommand, start: startCommand, stop: stopCommand, restart: restartCommand, logs: logsCommand, resolve: resolveCommand };

if (!command || command === 'help' || flags.help || flags.h) {
  console.log(HELP);
} else if (!commands[command]) {
  die(2, `Unknown command "${command}".\n\n${HELP}`);
} else {
  const failures = await commands[command](base, rest, flags);
  process.exitCode = typeof failures === 'number' && failures > 0 ? 1 : 0;
}
