# Features

Every feature helm-dev has, each with what it does, when it applies, when it
deliberately does not, and why. The *why* is the part worth reading: most of these
look simpler than they are, and the edge cases are where the decisions live.

This file describes behaviour. How it is built is in [`ARCHITECTURE.md`](ARCHITECTURE.md);
the implementation choices that look wrong are in [`CLAUDE.md`](CLAUDE.md).

**Keep it current.** A change that adds a feature or changes how one behaves updates
its entry here in the same commit. An entry describes what the code on this branch
does today — not a plan, and not what it used to do.

Each entry has the same shape:

> **What** it does · **When** it applies · **When not** — the cases it leaves alone
> · **Why** it is shaped this way · **Where** the code lives

---

## Starting and updating

### Self-update on start

- **What:** `./helm-dev` checks GitHub for new commits on the default branch before it
  starts. If there are any, it lists up to five and asks `Update now? [Y/n]`.
  No answer within 10 seconds counts as yes. After updating, the launcher re-runs
  itself from the new code, keeping its arguments (`--resume` and the rest).
- **When:** started from a terminal, on a clean checkout of the default branch
  (`origin/HEAD`, or `master`/`main` when that is not set).
- **When not:**
  - tracked files have local changes: an update could conflict with someone's work
  - another branch is checked out: that is someone working on helm-dev itself
  - stdin or stdout is not a terminal: nobody would see the prompt, and a script
    would stall for 10 seconds
  - offline, no access, or any git failure: the current version starts. The fetch
    is capped at 5 seconds and never prompts for a password or SSH host key.
  - `HELM_DEV_NO_UPDATE=1` is set
- **Why:** helm-dev is used straight from a clone, so without this everyone runs
  whatever they last pulled. It only ever fast-forwards (fetch, then
  `merge --ff-only`), so it cannot merge, rebase or lose work. The answer defaults
  to yes because an update is almost always wanted, while still giving anyone
  mid-task the chance to refuse.
- **Where:** `helm-dev`

### Resume the last session

- **What:** `./helm-dev --resume` restarts every service that was running when
  helm-dev last quit, in the same mode (plain or live).
- **When:** quitting helm-dev (Ctrl-C, SIGTERM, or closing the terminal: SIGHUP)
  writes the running list to `.cache/session.json` first.
- **When not:**
  - a second Ctrl-C exits at once *without* overwriting the list, so a habitual
    double-press does not wipe the session
  - nothing was running: the previous list is kept
  - a service that no longer exists in its workspace is skipped
- **Why:** quitting helm-dev stops everything it started, deliberately: closing a
  terminal should not orphan five services holding ports and gigabytes. `--resume`
  is what makes that cheap.
- **Where:** `server.mjs` (`shutdown`, the `--resume` block)

### Workspaces

- **What:** watches one or more Nx monorepos at once, each with its own section in the
  sidebar. Added by path (anything containing `nx.json`), removed, and reordered.
- **When:** the list is kept in `settings.json`. On first run, with nothing set up,
  the page asks for a path. `HELMDEV_REPO`, or the nearest `nx.json` above the
  current directory, is also opened.
- **When not:** two workspaces cannot share a display name; the second has to be
  given another one.
- **Why:** a developer may be working in one repository while running a single
  service from another. Everything else (file paths, open-in-editor, log
  attribution) carries the workspace, because the same relative path exists in
  every one of them.
- **Where:** `lib/workspace.mjs`, `server.mjs` (`/api/repos*`), `public/workspaces.js`

## Running services

### Start, stop, restart

- **What:** every Nx project with a `serve` target can be started (**▶**), restarted
  (**⟳**) and stopped (**×**). Restart waits until the old process has really exited
  and its port is free, then starts it again in the mode it had.
- **When:** from the page, from `helmctl`, or through the API.
- **When not:**
  - clicking a service's *name* never starts or stops it: that only filters the logs
  - a completed job cannot be stopped, since there is nothing left to signal
- **Why:** a fixed delay between stop and start used to launch the new process while
  the old one was still dying, and preflight then reported its own port as taken.
- **Where:** `lib/runner.mjs`, `server.mjs` (`restartService`)

### Restart all / stop all

- **What:** one action for every service that is up, in one workspace or in all of them.
- **When:** restart-all covers services helm-dev started that are `running` or
  `starting`. Stop-all also stops services started outside helm-dev.
- **When not:** restart-all leaves services started outside helm-dev alone and reports
  how many it skipped.
- **Why:** restarting an outside service would quietly move it under helm-dev, which
  nobody asked for by pressing a button for "all". Stopping one is a clear request
  either way.
- **Where:** `server.mjs` (`/api/restart-all`, `/api/stop-all`)

### Forced stop

- **What:** a stop sends SIGTERM to the whole process tree. If it has not exited
  after 6 seconds, it is sent SIGKILL.
- **When:** every stop, including the ones restart and quit perform.
- **Why:** SIGTERM is a request. A hung event loop or a missing shutdown hook used to
  leave a service on "stopping" forever. The tree is also walked through `ps`,
  because a child that started its own process group would otherwise keep holding
  the port.
- **Where:** `lib/runner.mjs` (`KILL_GRACE_MS`)

### Start queue

- **What:** starts are queued, and only a few cold-start at once. By default that
  number comes from the machine: available memory ÷ 3GB, cores ÷ 4, at most 3. It can
  be changed in **⚙**.
- **When:** whenever more services are asked for than may boot at once. The page shows
  each one's place in the queue.
- **Why:** every start is a webpack build. Ten at once takes the laptop down.
- **Where:** `lib/runner.mjs` (`setConcurrency`), `lib/settings.mjs`

### Preflight warnings

- **What:** before a start, it checks whether there is enough memory for the build and
  whether a port the service used last time is already taken. If either looks risky,
  it asks first. Confirming starts the service anyway.
- **When:** every start from the page or `helmctl start`, unless forced (`--force`).
- **When not:**
  - the first start of a service has no known port yet, so a clash shows up as the
    service's own EADDRINUSE instead
  - no `ss` or `/proc` (macOS): nothing can be checked, so nothing is warned about
- **Why:** both problems are ones a developer only notices once the machine is already
  swapping. The memory figures are deliberately conservative (frontend 2.5GB, app
  900MB, job 700MB, plus 1.2GB headroom), because a wrong guess costs ten minutes
  of swap.
- **Where:** `lib/preflight.mjs`

### Plain and live frontends

- **What:** a frontend starts with watching and live reload off (**▶**), or with both
  on (**▶L**). Backends always start plain.
- **When not:** live mode is never the default.
- **Why:** Angular's watcher costs gigabytes. Most of the time a frontend only needs to
  be up, not rebuilding on every save.
- **Where:** `server.mjs` (`startService`)

### Status: starting, running, unconfirmed, failed, completed

- **What:** a service is `running` once a port opened by its own process tree is
  listening. If no port shows up within 60 seconds it is assumed up but flagged
  **unconfirmed**, rather than claimed as healthy. It is `failed` when its first boot dies, and a job is `completed` when it
  exits.
- **When not:** an app that has already booted and restarts under Nx's watch mode is
  not failed, even though Nx prints the same exit line.
- **Why:** the tool must never claim a service is up when it is not. Startup messages
  differ between repositories and are printed before a service can die on a missing
  env var. An orphan on the right port once confirmed a service that had never
  started, which is why the pid has to belong to the service.
- **Where:** `lib/runner.mjs`

### Port learning

- **What:** a service's ports are learned from the sockets its process tree opens, and
  remembered for preflight and restart. Node's inspector ports are excluded.
- **When:** while a service runs. One marked ready by a log line is still watched for
  its port for 2 minutes.
- **When not:** never read from `.env`, `.env.example` or `project.json`.
- **Why:** each of those files described a port the service did not always use.
  Inspector ports are excluded by what the process announces on stderr, not by port
  number, because a cluster has one per process.
- **Where:** `lib/runner.mjs`, `lib/preflight.mjs` (`listeners`)

### Services started outside helm-dev

- **What:** an `nx serve` running in a terminal is detected and shown with a blue dot.
  It can be stopped or restarted from helm-dev; a restart moves it under helm-dev.
- **When:** checked every 8 seconds (`HELMDEV_DETECT_MS`). A process counts for a
  workspace only when its working directory is inside it.
- **When not:** Linux only, since it reads `/proc`.
- **Why:** without this, a service started by hand looked stopped, and starting it
  again failed on a taken port.
- **Where:** `lib/detect.mjs`

### Stale services

- **What:** a running service is marked stale, with a count of changed files, once
  its own source or a shared library it imports changes after it started.
- **When:** any service that is up, including one started outside helm-dev.
- **Why:** after an edit, the commonest wasted ten minutes is debugging a service
  still running the old code. Which libraries count is read from the workspace's own
  TypeScript path aliases.
- **Where:** `lib/watcher.mjs`

### Mute

- **What:** a muted service keeps running, but its logs are neither buffered nor
  shown. Its status stays accurate.
- **When:** frontends are muted by default (**⚙** → mute frontends). A muted service
  shows a **muted** badge; clicking it turns its logs back on.
- **Why:** a chatty frontend can fill the 50MB buffer and push out the lines that matter.
- **Where:** `lib/runner.mjs` (`setMuted`)

### Presets

- **What:** **+ save running** stores the current set of running services under a name.
  Clicking the preset later starts them all.
- **Where:** `.cache/presets.json`, `public/services.js`

## Logs

### One merged stream

- **What:** every service's output, from every workspace, in one stream in arrival
  order. Kept in a 50MB in-memory buffer (`HELMDEV_BUFFER_MB`, or **⚙**) that drops
  the oldest lines first.
- **When not:** a record's payload is capped at 8KB.
- **Why:** the line that explains a failure is often in a different service from the
  one that failed.
- **Where:** `server.mjs` (`broadcast`), `public/logs.js`

### Log formats

- **What:** parsed in order: pino NDJSON (services are started with `LOG_FORMAT=json`),
  pino-pretty, Nest's bootstrap format, then raw lines. Indented continuation lines
  (stack traces, pretty-printed objects) are folded into the line above.
- **Why:** timestamps come from the line itself, so a backed-up pipe does not
  reorder anything.
- **Where:** `lib/runner.mjs` (`toRecord`)

### Filters

- **What:** by level, free text (which also searches structured fields), service,
  and trace. **noise** hides Nest bootstrap and Nx/webpack build output, about 78% of
  a typical session. Identical consecutive lines fold into one row with `×N`.
- **When not:** a developer's own `console.log` is never noise. It sits under the
  **raw** level.
- **Why:** filters are a view over the buffer, never a deletion. Hiding something
  loses nothing, and turning it back on brings it all back.
- **Where:** `public/filters.js`

### Trace an id

- **What:** from a line's detail pane, filter the whole stream to lines carrying the
  same `reqId`, `userId`, `botId`, `botUserId`, `sessionId`, `campaignId` or
  `flowStepId`.
- **Why:** following one request across services is the commonest debugging path here.
- **Where:** `public/filters.js` (`TRACE_KEYS`), `public/detail.js`

### Clear

- **What:** **clear** on the page hides everything up to now, but keeps it in the
  buffer. The API's clear actually frees the buffer, for the server and for every tab.
- **Where:** `public/logs.js`, `server.mjs` (`/api/clear`)

### Logs from a terminal

- **What:** any `<service>.log` file in the drop directory (`HELMDEV_TAIL_DIR`, by
  default `<tmp>/helm-dev-logs-<user>`) is tailed into the stream. For example:
  `npm start ikit 2>&1 | tee <dir>/ikit.log`.
- **When not:** when two open workspaces both have a project with that name, the
  lines stay unattributed.
- **Why:** a service started in a terminal cannot be piped into helm-dev; a file can.
  When the name is ambiguous, guessing a workspace would mean lying about where a
  line came from.
- **Where:** `lib/tailer.mjs`

## From a log line to its source

### Resolve to file:line

- **What:** clicking a line shows the source line that printed it, the code around it,
  its payload and exact timestamp. Each answer comes with a confidence: `exact`,
  `pattern`, `prefix`, `constant`, `definition`, `ambiguous` (every candidate listed)
  or `none`.
- **When not:**
  - lines from `node_modules`, the build or third-party warnings say *not found*
  - a match only in another service's source is never used: no source is better
    than the wrong one
- **Why:** the index scans `apps/` and `libs/` for every logging call (about 10,000
  per monorepo) in a child process, so the scan's garbage does not stay in the
  server's memory. It rebuilds when the branch or commit changes, or with
  **reindex** / `--reindex`.
- **Where:** `lib/log-index.mjs`, `server.mjs` (`/api/resolve`, `/api/source`)

### Open in editor, copy a Claude prompt

- **What:** **open** runs `HELMDEV_EDITOR` (default `code -g {file}:{line}`) on the
  resolved line. **copy Claude prompt** copies a ready-made prompt: the line, the
  `file:line` it came from, its payload, and the 15 lines before it from the same
  service.
- **When not:** a path outside the workspace is refused.
- **Where:** `server.mjs` (`/api/open`), `public/detail.js`

## Tools around it

### helmctl

- **What:** a command line for a running helm-dev: `status`, `start`, `stop`,
  `restart` (`--all`), `logs` (filters, `--follow`), `resolve`. `restart` waits until
  the service is up or says why it is not. It exits 0 when done, 1 on a failed or
  timed-out service, and 2 for bad usage or when no server is running.
- **Why:** so a script or an AI assistant can check on and restart services without
  the browser. It is only a client of the same server, so it shows exactly what the
  page shows.
- **Where:** `helmctl`, `cli.mjs`

### Claude Code skill

- **What:** `skills/helm-dev/` teaches Claude Code to use `helmctl`, and to ask once
  per chat whether the user uses helm-dev. Installed by symlinking it into
  `~/.claude/skills/`.
- **Where:** `skills/helm-dev/SKILL.md`

### Bug reports

- **What:** the report form files a GitHub issue through `gh`, with the category, the
  steps, up to five screenshots, and helm-dev's state attached (version, workspaces,
  stats, settings, filters). The metadata can be previewed before sending.
- **When not:**
  - `gh` is missing or not logged in: the form says so before anything is typed
  - the request comes from another site's page: refused
- **Why:** filing an issue acts as the person's GitHub account, and any browser tab
  can reach localhost, so this is the one route that checks the origin. Screenshots
  go on a separate `report-assets` branch, because `gh issue create` cannot attach
  files. A public repository gets a warning to leave out anything private.
- **Where:** `lib/report.mjs`, `public/report.js`

### Footprint in the header

- **What:** helm-dev's own memory, each service's memory, available memory, buffer use,
  open file watches and git state, refreshed in the background.
- **Why:** footprint is a feature here, so it is shown rather than assumed.
- **Where:** `lib/stats.mjs`, `server.mjs` (`refreshStats`)
