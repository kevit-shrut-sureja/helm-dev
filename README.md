# devscope

A local, zero-dependency log console for the Chatomate monorepo. Runs services,
merges their logs into one filterable stream, and resolves any log line back to
the exact `file:line` that emitted it — one click from there into VSCode, or into
a ready-made Claude prompt.

Lives outside the repo on purpose (nothing committed yet). Node 22, no `npm install`.

## Sharing it with someone

Copy the `devscope` folder into **their** repo at the same place, `<repo>/tmp/devscope`,
and run `./run.sh`. It finds the repo by walking up for `nx.json`, and `tmp/` is
already gitignored, so nothing needs configuring and nothing reaches git.

Before zipping it, delete `.cache/` — it holds a 2MB index and a session file from
your machine. Not doing so is no longer harmful (the index records the repo path
and commit it was built from and rebuilds itself when either differs), but it saves
them a pointless 2MB.

Requirements on their side: **Node 20+** (recursive file watching) and **Linux**.
The Linux parts are detecting services started outside devscope (`/proc/<pid>/cwd`),
per-service memory (`ps`) and killing a process tree. On macOS those degrade
quietly rather than crashing — the log viewer, index and runner still work. There
is no Windows support.

If they do not use VSCode, `DEVSCOPE_EDITOR` takes any command, e.g.
`DEVSCOPE_EDITOR='idea --line {line} {file}' ./run.sh`.

## Run

```bash
cd <this folder>
DEVSCOPE_REPO=/home/kevit/work/chatomate ./run.sh
# → http://localhost:7788
```

Env:

| Var | Default | Purpose |
|-----|---------|---------|
| `DEVSCOPE_REPO` | nearest `nx.json` above cwd | monorepo to watch |
| `DEVSCOPE_PORT` | `7788` | dashboard port |
| `DEVSCOPE_TAIL_DIR` | `<os temp>/devscope-logs-<user>` | drop dir for tailed log files |
| `DEVSCOPE_EDITOR` | `code -g {file}:{line}` | command used by "open in VSCode"; `{file}` and `{line}` are substituted |
| `DEVSCOPE_BUFFER_MB` | `50` | log buffer budget in megabytes (FIFO) |
| `DEVSCOPE_DETECT_MS` | `8000` | how often to scan for externally started services |

## Stats

The header shows the current git branch, modified and untracked counts, how many
services are up with their combined memory, and devscope's own RSS. Each running
service shows its own memory in the sidebar — the whole process tree, since an
`nx serve` is a wrapper chain with the real application at the bottom.

**Colour themes** — slate, midnight, carbon, black (true #000, for OLED panels), amber and light; remembered per browser.
The detail pane is **drag-resizable** from its left edge, also remembered.

## Footprint

~74MB RSS steady state, of which ~41MB is bare Node — so devscope itself costs
about 33MB. It holds the call-site index (10,449 entries, ~5MB retained) and an
8,000-line ring buffer (~2MB); everything else is V8 overhead.

This is close to the floor for Node. Measured alternatives: V8 flag tuning took
it from 82MB to 74MB and no further; the same index and buffer in Go measured
**20.6MB** (see `../go-comparison`). If the footprint has to go lower, a Go port
is the only thing that moves it meaningfully.

Kept small deliberately:

- the index is built in a **child process that then exits**, so the garbage from
  scanning ~6k files never lands in the long-running server (this alone took it
  from 110MB to 68MB);
- only **sentence-like constants** are indexed (8+ chars containing a space),
  which cut 11,179 constant entries to 2,975 without losing a single match;
- one **shared recursive watch per directory**, fanned out to every service that
  depends on it, rather than one watch per service per lib;
- **frontend projects are muted by default** — Angular build output is huge and
  rarely what you are debugging, so it is not even buffered until you unmute;
- services **boot one at a time** through a queue, so clicking ten of them does
  not start ten cold Nx builds at once;
- idle cost is one `ps` every 8s; everything else is event-driven (SSE, inotify).

## What it does

**Run services** — every Nx project with a `serve` target is listed.

| Click | Does |
|-------|------|
| the service **name** | focuses the log pane on that service (click again to unfocus) — never starts or stops anything |
| `muted` badge | turns that service's logs on (frontends start muted) |
| ▶ | starts it under devscope and focuses it |
| ⟳ | stops the running process and starts a fresh one |
| × | stops it |

Save the running set as a preset ("campaign work = platform-apis + excalibur + ikit").

Running services sort to the top of the list; queued ones show their position.

**Boot state** — amber and pulsing while building and booting, green only once
the *application* reports it is up (`Nest application successfully started`,
`Application bundle generation complete`, …). Build-time lines like `webpack
compiled successfully` and `Debugger listening on` deliberately do **not** count:
they appear minutes before the app is ready, and are still printed by one that
then dies. If the app fails to boot while Nx keeps the task alive, the row goes
red with `boot failed` and the reason. A service that prints no recognisable
signal within 60s is shown green but badged `unconfirmed`. Blue dot = started
outside devscope.

**clear** empties the screen only — the buffer is untouched and **restore**
brings the lines back.

**Already-running services** — devscope scans `ps` every 4s for `nx serve`
processes and confirms each one's `/proc/<pid>/cwd` belongs to *this* repo, so a
service running from another workspace is never claimed. Those show a blue dot
and an `ext` tooltip. It can stop and restart them, but **it cannot retroactively
capture their stdout** — see "Logs from an already-running service" below.

**Stale detection** — because `npm start` runs with `--watch=false`, a running
service silently goes stale the moment you edit code. devscope watches each
running service's `src/` *and every `@chatomate/*` lib it imports*; on any change
the row turns amber with an `NΔ` badge. Hit ⟳ to stop the old process and start a
fresh one.

**Logs → source** — at startup it indexes every `logger.{log,error,warn,debug,…}`
call in `apps/` + `libs/` (~4k sites, ~0.6s), recording the message literal, the
enclosing class and the `file:line`. At runtime it matches a log's `msg` against
that index, narrowed by the pino `context` field. Confidence is reported:

Log messages are rarely plain literals, so the index resolves them four ways:

| Badge | How it matched | Example in this repo |
|-------|----------------|----------------------|
| `exact` | the literal in the call | `logger.debug('setFlowStepTimeout(): called')` |
| `pattern` | a template literal, compiled to a regex | `` logger.log(`Sending ${id}`) `` |
| `prefix` | a `console.log('label', value)` — only the label is in the source | `console.log('pricingFromRedis', obj)` |
| `constant` | the message is an enum/constant; found by value, then traced to the call site that logs that name | `logger.error(BOT_ERROR_CODES.BOT_NOT_AUTHENTICATED)` |
| `definition` | the constant's value is known but no call site references it — points at where the text is defined | shared error maps |
| `ambiguous` | several sites match; **all of them are listed** in the detail pane, each openable | a message used in more than one place |
| `none` | nothing indexed matches — e.g. `logger.error(err)`, or framework logs from `node_modules` (Nest's `RouterExplorer` lines) |

### What string matching cannot do

Resolution works by matching the printed message back to the source. That is exact
when the message appears once, and a guess when it does not. Measured on this repo:

| | Count | Share |
|---|---:|---:|
| Messages logged from exactly one place | 4,251 | **91%** |
| Logged from several places in different classes | 143 | resolved by the pino `context` |
| Logged from several places **in the same class** | 279 | cannot be separated |

For that last group the log line genuinely does not contain enough information —
same text, same class, and the log level differs in only 8 of 345 cases, so level
does not help either. devscope therefore does not guess: it badges the result
`ambiguous` and lists **every** candidate `file:line`, each one clickable straight
into VSCode.

If you ever need certainty rather than candidates, the only source of truth is the
runtime: a `mixin` in the dev logger config capturing one stack frame per log,
which turns every line into an exact location at the cost of a few microseconds
per call and needing source maps resolved through the Nx build.

**Per-service logger styles** are handled: `nestjs-pino` (`this.logger.*`), legacy
`platform`'s log4js-style wrapper (`log.error('msg', arg)` — 2,854 call sites),
plain `console.*`, and Nest's own bootstrap logger. A `console.*` hit is badged
**temporary debug**, since those are the lines you added while developing and
will want to delete.

Click the path to open it in VSCode, or **copy Claude prompt** to get the log
line, its resolved source location, the payload and the 15 preceding lines from
that service, formatted as a question — paste straight into Claude Code.

## Logs from an already-running service

stdout of a process devscope did not spawn cannot be attached to — the log pane
says so explicitly when you focus such a service. Two options:

1. **Restart it under devscope** (⟳) — full capture, nothing else to do.
2. **Tee your terminal into the drop dir** — keeps your own terminal:
   ```bash
   npm start ikit 2>&1 | tee /tmp/devscope-logs/ikit.log
   ```
   devscope tails `<service>.log` and folds it into the same stream. The file
   name must match the Nx project name.

## Log formats

Both are parsed:

- **pino-pretty** (current default) — ANSI stripped, level/context/message
  recovered, indented continuation lines folded back into their record.
- **Nest's built-in logger** (`[Nest] 123 - date LOG [NestFactory] …`) — the
  format services print while bootstrapping, before pino takes over.
- **Nx / webpack tooling chatter** — kept as `raw` so a normal build never
  renders as red errors.
- **NDJSON** — richer and more reliable. Requires a one-line change in
  `libs/shared-configs/src/lib/logger.config.ts` to skip the pretty stream when
  `LOG_FORMAT=json`; devscope sets that env var on the services it starts.
  The change plus the matching `.env.example` entries are saved next to this
  folder as `repo-changes-for-devscope.patch`:
  ```bash
  cd /home/kevit/work/chatomate && git apply ../path/to/repo-changes-for-devscope.patch
  ```

## Gotcha worth knowing

Services are spawned with `--output-style=stream-without-prefixes`. Nx's default
`static` style **buffers a task's entire output until the task finishes**, which
for a long-running `serve` means no logs at all until it dies. `stream` flushes
live; `-without-prefixes` stops Nx prepending `<project>: ` to every line, which
would otherwise break the message → call-site matching.

## Watch / live reload

Only frontends have it, and only when asked for.

| Button | Runs | Cost |
|---|---|---|
| **▶** | `nx serve <app> --watch=false --liveReload=false` | the cheap way; no rebuild on change |
| **▶w** | `nx serve <app>` (Angular's defaults) | rebuilds and refreshes the browser on change, at a large memory cost |

A service started with **▶w** carries a **live** badge so the mode is obvious at a
glance, and `--resume` restores each service in the mode it was running in.

Backends have no equivalent and are always started plain, exactly as they were
before: `@nx/js:node` delegates watching to the Nx daemon, which does not run
here (`nx daemon --status` → *not running*, and forcing `NX_DAEMON=true` does not
change it because devscope pipes stdout, which Nx treats like CI). They still get
the `NΔ` stale badge so you know when a manual **⟳** is due.

## Jobs that finish

A worker is supposed to end, so finishing is a result rather than a failure. The
row goes to a hollow green dot with a **done 21.6s** badge, keeps its logs, and
offers **▶** to run it again.

Detecting that is less obvious than it sounds. Each job ends in its own way, and
`nx serve` does **not** exit when the job does — it prints

```
NX  Process exited with code 0, waiting for changes to restart...
```

and then sits idle waiting for a file change. So devscope watches for that one Nx
line, which is identical for every service, rather than trying to recognise each
job's own closing messages. Exit code 0 on a `type:job` project means **completed**;
any other code means **failed** with the reason; a non-job exiting 0 is **stopped**.
The idle wrapper is then terminated, so it cannot silently re-run the job the next
time a file changes.

Jobs are also marked up as soon as they log anything of their own — they never
print "listening on a port", so without that they used to sit in `starting` for a
minute before being labelled `unconfirmed`.

## When a service fails to start

The row turns red with **boot failed** and the reason, taken from the most
specific error line rather than Nx's generic `Failed tasks:`. Focusing the service
shows the reason in the log pane with a pointer to turn on **raw** and **noise**
for the full build output. Verified against a real failure:
`ichnaea` → *Error: SAAS_DB_URI is required*.

A failed start no longer leaves debris: stopping a service signals its whole
process tree, not just the process group, because a child that started its own
group used to survive, keep the port, and make the next start fail with a
misleading error.

## Settings

Click the **⚙** next to the title. Two kinds of setting, kept deliberately apart:

| Where | What | Why there |
|---|---|---|
| `settings.json` (next to devscope, server-side) | start concurrency, log buffer MB, mute frontends | properties of **this machine**, enforced by the server; must apply with no browser open |
| browser `localStorage` | theme, detail-pane width, level filters, focused services, noise toggle | per-viewer taste; should not follow the machine or affect a colleague |

**Start concurrency** decides how many services may cold-start at once. Each start
runs a webpack build, so the ceiling is RAM and cores, not preference. Left unset
it auto-detects from the machine — `min(4, totalmem/8GB, cores/4)` — which is 3 on
a 12-core/31GB box and 1 on a small laptop. The slider overrides it; the override
is what gets stored, so moving the file to another machine is not a good idea.

`bufferMB` and `muteFrontends` apply immediately. Every setting takes effect
without a restart.

## Timestamps

A record carries **the time the service logged it**, not the time devscope read
the pipe — the two differ by however long the line sat in the buffer, which is
exactly the difference that matters when you are correlating backend events.

The time is parsed out of the printed line: `[2026-09-22 12:43:34.567]` from
pino-pretty, or `22/09/2026, 6:15:17 pm` from Nest's own logger (which prints no
milliseconds, so those land on the second). In NDJSON mode pino's `time` field is
used directly. If neither is present — build output, a bare `console.log` — the
arrival time is used as a fallback.

The detail pane shows the full timestamp to the millisecond, with the UTC ISO
form under it and a **copy** button, since that is usually what gets pasted into
a ticket or a database query.

## Log retention

Logs are **never written to disk**. They live in a fixed-size FIFO buffer in
memory: once the budget is full, the oldest lines are dropped to make room. A
devscope restart loses the buffer, and so does restarting a service.

The cap is a **byte budget, not a line count** (`DEVSCOPE_BUFFER_MB`, default
50MB), because size per line varies hugely — only 30% of lines carry a payload
but those payloads are 63% of all bytes. A line count would mean a buffer that is
tiny in one session and enormous in another. A single oversized payload is
truncated at 8KB so one dump cannot evict everything else.

Why 32MB, measured on this machine:

| Buffer | Lines held | Filter pass | Browser heap |
|---:|---:|---:|---:|
| 32MB | ~25k–60k, depending on payload volume | 20–45ms | ~10–20MB |
| **50MB (default)** | ~40k–99k | **35–70ms** | ~15–30MB |
| 100MB | ~80k–190k | 70ms+ | ~50MB |

A record costs ~305 bytes of heap and a filter pass is linear, so 32MB keeps
search comfortably inside the 120ms debounce while holding several hours of idle
logging (~146 lines/min with services idle). At 50MB a filter pass costs 35–70ms, still comfortably inside the 120ms search
debounce. Change it with `DEVSCOPE_BUFFER_MB`; the UI shows live usage as
`buffer 12/50MB`.

Stopping devscope stops the services it started. It writes the list to
`.cache/session.json` first, so `./run.sh --resume` brings the same set back.

## Daily-use behaviour

Measured on a real session of 3,018 captured lines:

- **78% of lines were Nest bootstrap and Nx build output**, not application logs.
  Those are hidden by default; the **noise** button brings them back.
- **20% were consecutive duplicates.** Identical neighbouring lines fold into one
  row with a `×N` count. Click the count to expand the run into its individual
  lines — each keeps its own timestamp and payload and opens its own detail pane —
  and click `×N ▴` on any of them to fold it back.
- Together these turn 3,000 buffered lines into **583 worth reading**.

**Tracing.** A record's payload is scanned for `reqId`, `userId`, `botId`,
`botUserId`, `sessionId`, `campaignId` and `flowStepId`; each one found becomes a
`trace <key>` button in the detail pane. Tracing filters the buffer to every line
carrying that id and drops the text filter, since the intent is "show me
everything about this". In practice `userId` is the useful one here — a trace
returned 206 related lines where `reqId` returned 1, because services log through
the application logger rather than pino-http's request-scoped child.

**Origins that are not yours** are labelled as such rather than as failures: Nest
framework logging, Nx/webpack output, and third-party warnings (SendGrid, KafkaJS,
Mongoose) say *not your code* instead of *not found*.

**Keyboard** (press `?` in the app for the list): `/` focus the filter · `e` / `E`
next / previous error · `f` follow · `n` toggle noise · `Esc` drop the trace, then
close the detail pane.

Three rules keep them out of the way:

- anything with `Ctrl` / `Cmd` / `Alt` goes to the browser, so **`Ctrl+C` copies**;
- nothing fires while text is selected, because that means someone is copying;
- **clearing has no key binding at all** — it sits one modifier away from copy, so
  it is button-only. `clear` empties the screen; `restore` brings it back.

Single-key shortcuts can be switched off entirely in the `?` panel.

Filter levels, focused services and the noise setting are remembered across
reloads, as are the theme and the detail-pane width.

## Resolution coverage

Measured against that same real session, by where the line came from:

| Origin | Distinct messages | Resolved to source |
|---|---:|---:|
| Application code in this repo | 99 | **82%** |
| Nest framework (`node_modules`) | 870 | 0% — expected, not this repo |
| Nx / webpack tooling | 27 | 0% — expected |

The unresolved 18% of application lines are almost entirely third-party library
warnings, which also have no source here.

## UI notes

The log pane is **virtualised**: only the ~60 rows on screen exist in the DOM,
positioned by a translated window inside a spacer sized to the full list. Rows are
therefore a fixed 20px and a long message is truncated with an ellipsis — the full
text, payload and source are one click away in the detail pane.

Measured on 2,602 buffered lines:

| | Before | After |
|---|---|---|
| rows in the DOM | 2,602 | 60 |
| total DOM nodes | 15,826 | 576 |
| filter keystroke | 177ms | 0.1ms (filter is debounced 120ms) |
| scroll repaint | — | 0.9ms |

The buffer can grow without affecting render cost, since paint work depends on
viewport size, not buffer size.

Scrolling is anchored: changing a filter (noise, levels, text, focus) keeps the
line you were reading in view rather than jumping to an arbitrary offset, and
expanding a `×N` run holds the clicked row exactly where it sits — including at
the bottom edge, where the new rows would otherwise push it off screen. Turning
**follow** on jumps to the newest line immediately instead of waiting for one to
arrive; expanding a run turns follow off, since being dragged back to the bottom
would defeat the point.

## Layout

```
server.mjs          HTTP + SSE, no framework
lib/projects.mjs    discovers serveable Nx projects
lib/runner.mjs      spawns nx serve, parses both log formats
lib/log-index.mjs   builds + queries the logger call-site index
lib/detect.mjs      finds and kills externally started services
lib/watcher.mjs     per-service source + dependency watching (staleness)
lib/tailer.mjs      tails <service>.log drop files
public/             single page, vanilla JS
.cache/             log-site index + saved presets
```

## Not built yet

- **Ask Claude in-panel** — the prompt is copy-to-clipboard today; streaming
  `claude -p` output into a side panel is the next step.
- **DB panel** — read-only Mongo/Redis queries next to the logs.
- Restarting an *external* service (kill its process group, restart under
  devscope) is implemented but has not been exercised against a live service.
