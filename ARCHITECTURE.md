# Architecture

How helm-dev runs services, turns their output into one searchable stream, and
gets that stream onto a page — and why each part is shaped the way it is.

Two rules decide most of what follows:

- **It must not slow the machine down.** It sits beside an editor, a browser and
  several heavy services. Footprint is a feature.
- **It must never lie about state.** A service shown as running when it is not, or
  a log line attributed to the wrong source, is worse than showing nothing.

## The shape of it

```
┌─ your browser ─────────────┐        ┌─ helm-dev (one node process, no deps) ──────────┐
│  9 ES modules, no bundler  │        │                                                 │
│                            │        │  Workspace ── Runner ── spawn npx nx serve ──┐  │
│  virtualised log pane  ◀───┼── SSE ─┼─ broadcast()                                 │  │
│  sidebar, detail pane      │        │     ▲   ▲                                    │  │
│                            │──REST─▶│     │   └── LogTailer (files from elsewhere) │  │
└────────────────────────────┘        │     └────── 50MB FIFO buffer                 │  │
                                      │  LogIndex (built in a child process)         │  │
                                      └──────────────────────────────────────────────┼──┘
                                                                                     ▼
                                                               nx → webpack → node <service>
```

One process, no dependencies, no build step. The page is served from `public/`
and talks to the same process over REST plus one SSE stream.

## 1 · Running a service

```
click ▶ ──POST /api/start──▶ preflight (memory, port owner)
                                  │  409 + warnings if risky, retried with force
                                  ▼
                            Runner queue ── started #concurrency at a time
                                  │         (auto: MemAvailable/3GB, cores/4, max 3)
                                  ▼
        spawn('npx', ['nx', 'serve', name, '--output-style=stream-without-prefixes'])
        cwd: <workspace root>   detached: true   stdio: [ignore, pipe, pipe]
        env: LOG_FORMAT=json  FORCE_COLOR=0  NX_TUI=false
```

The command runs in the workspace root, exactly as you would type it. helm-dev is
a supervisor, not a runtime — it never imports your code.

Four details carry weight:

- **`--output-style=stream-without-prefixes`.** Nx's default `static` style buffers
  a task's entire output until it finishes. For a `serve` that never finishes, that
  means no logs at all. The suffix stops Nx prefixing every line with the project
  name, which would break log→source matching.
- **`detached: true`** gives the child its own process group, so stopping signals the
  whole tree. Anything that escapes the group is caught by walking `ps -eo pid=,ppid=`
  — that is what stops an orphaned build from sitting on the port afterwards.
- **`LOG_FORMAT=json`** asks Nest services for NDJSON, the only format that parses
  losslessly. Everything else is fallback.
- **Frontends get `--watch=false --liveReload=false`** unless live mode is chosen.
  Angular's watcher costs gigabytes.

Starts are queued because each one is a webpack build. The default concurrency is
derived from the machine, not hardcoded, and is overridable in the settings panel.

## 2 · A line becomes a record

```
child.stdout ─▶ lineSplitter ─▶ #ingest ─▶ toRecord ─▶ 'log' event
                (holds a partial   │          │
                 chunk until \n)   │          ├─ 1. NDJSON (pino)    level 30 → info, msg, context, fields
                                   │          ├─ 2. pino-pretty      "INFO [Ctx]: msg"
                                   │          ├─ 3. [Nest] bootstrap "[Nest] 123 - … LOG [Ctx] msg"
                                   │          └─ 4. raw              stderr → error, unless Nx noise
                                   │
                                   ├─ folds indented continuation lines (stack traces,
                                   │  pretty-printed payloads) into the previous record,
                                   │  flushed 40ms later
                                   └─ watches the same stream for readiness, boot
                                      failure, and a job's exit
```

Timestamps come from the text the service printed, not from when helm-dev read the
pipe, so a line keeps the service's own time even if the pipe was backed up.

## 3 · Readiness, failure, completion

Readiness deliberately does **not** come from log text. `webpack compiled
successfully` and `Debugger listening on` are printed long before a service is up,
and by services that then die on a missing env var.

Instead: **a listening port whose pid belongs to that service's process tree.** The
port comes from the project's own config; the pid check exists because an orphan
from an earlier run once confirmed a service that had never started. If no port is
ever confirmed, the service is marked running after 60 seconds and flagged
*unconfirmed* rather than claimed as healthy.

Failure and completion are read from the stream, because **Nx keeps a failed or
finished task alive**: a job that ends is detected from Nx's own
`Process exited with code N` line, and only for projects tagged `type:job` — for a
long-running service that same line means Nx is restarting the inner process.

## 4 · Many services, one stream

```
workspace A ─ runner ─┐
workspace B ─ runner ─┼─▶ broadcast(type, payload)
tailer ───────────────┘        │
                               ├─ seq += 1              ← one counter, total order
                               ├─ capPayload (8KB max per record)
                               ├─ buffer.push, evict to 50MB
                               └─ frame → every SSE client
```

The single sequence counter is the whole trick for interleaving: records from
different processes are ordered as they arrive, so nothing downstream has to sort
or guess.

**Eviction is batched.** Dropping one record per arriving line moves the whole
array each time — 121ms per 1000 lines on a full buffer, against 0.9ms when
evicting down to a 95% low-water mark in one pass.

**Log frames are coalesced over 16ms; status frames are not.** A burst of hundreds
of lines becomes one write, while anything the UI reacts to goes out immediately
and takes the waiting lines with it, so ordering is never disturbed.

**Services started outside helm-dev** cannot be piped, so they are read from
`<tmp>/helm-dev-logs-<user>/<service>.log`, polled every 400ms. A file is
attributed to a workspace only when exactly one open workspace has a project by
that name — with two monorepos that both contain `platform`, guessing would be a
lie, so the line stays unattributed.

## 5 · The page

```
boot   GET /api/state           workspaces, projects, statuses, presets, stats
       GET /api/logs?limit=3000 the backlog
       EventSource /api/events  open for the session

line   appendLog(record)
         push to state.logs, same 50MB budget, same batched eviction
         passesFilters? no → stop (it stays in the buffer, just unrendered)
         identical to the line above? → fold into that row (×6)
         mark metrics dirty, requestAnimationFrame

frame  paintWindow()
         one layout read for the whole frame
         spacer height = rows × 20px      ← gives the scrollbar its size
         ~60 rows rendered, translated into place; the rest is arithmetic
```

The buffer is the source of truth and filters are a view over it. That is why
hiding noise loses nothing, and why **clear** only moves a watermark.

Nothing in the hot path reads layout per line. `appendLog` sets a flag; the spacer,
the counter and the follow position are written once per frame, and the follow
position is computed from the row count rather than read back as `scrollHeight` —
reading layout straight after writing it forces a synchronous reflow.

## 6 · A log line back to its source

At startup a child process scans `apps/` and `libs/` for every logging call and
records what it can print: string literals, template literals as regexes,
`console.*` prefixes, and SCREAMING_SNAKE constants resolved to their definitions.
About 10,000 call sites per monorepo, in roughly 600ms. It runs in a child process
because scanning 6,000 files leaves enough garbage to raise the long-running
server's RSS by tens of megabytes.

Resolution scores a message against that index and answers with a confidence:
`exact`, `pattern`, `prefix`, `constant`, `definition`, `ambiguous` or `none`. The
service's own root narrows ambiguous matches. The cache is keyed by repository path
and git head, so switching branches rebuilds it.

Then `/api/source` reads the lines around the match and `/api/open` launches your
editor. Both take the record's repo, because the same relative path exists in every
open workspace.

## 7 · Where state lives

| What | Where | Survives |
|---|---|---|
| log records | memory, 50MB FIFO, server and tab | until restart |
| workspaces, concurrency, buffer size, mute | `settings.json` | restart |
| presets ("save running") | `.cache/presets.json` | restart |
| log-site index | `.cache/index-<repo>.json` | until the branch changes |
| last session's services | `.cache/session.json` | read by `--resume` |
| theme, widths, focus, pins, collapsed, filters | browser `localStorage` | per browser |

## 8 · Where to change things

```
server.mjs          HTTP + SSE, routes, workspace lifecycle, the buffer
lib/workspace.mjs   one watched repository and everything derived from it
lib/runner.mjs      spawns nx serve, parses log formats, boot/failure states
lib/log-index.mjs   builds and queries the log-site index
lib/projects.mjs    discovers and classifies Nx projects
lib/detect.mjs      finds services started outside helm-dev
lib/watcher.mjs     source watching for staleness
lib/preflight.mjs   memory and port checks before a start
lib/stats.mjs       per-service memory, git state
lib/tailer.mjs      tails <service>.log drop files

public/app.js       boot: load state, paint, subscribe, hand over
public/core.js      shared state, the element map, helpers
public/services.js  the sidebar
public/workspaces.js  adding, removing and reordering repositories
public/filters.js   what reaches the log pane
public/logs.js      the virtualised log pane
public/detail.js    the pane that opens on a line
public/panels.js    settings and help
public/layout.js    theme and the draggable dividers
public/styles/      one stylesheet per area, cascade order set by index.html
```

See [`CLAUDE.md`](CLAUDE.md) for the conventions and for the decisions that look
wrong until you know the measurement behind them.
