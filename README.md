<div align="center">
  <img src="public/logo.svg" width="56" alt="" />
  <h1>helm-dev</h1>
  <p><em>A local control panel for Nx monorepos.</em></p>
</div>

Runs your services, merges their logs into one filterable stream, and resolves
each log line back to the source line that printed it — one click from there into
your editor, or into a ready-made Claude prompt.

Built for a working day that looks like this: five services running, one of them
misbehaving, and the log line that explains it buried somewhere in three thousand
others.

**No dependencies. No build step. No install.** Node's standard library only.

```bash
git clone git@github.com:kevit-shrut-sureja/helm-dev.git
cd helm-dev && ./helm-dev          # → http://localhost:7788
```

On first run it asks for the path to an Nx workspace. After that:

```bash
./helm-dev --resume     # restart whatever was running when it last stopped
./helm-dev --reindex    # rebuild the log-site index
```

## What it does

- **Runs services.** Every Nx project with a `serve` target, started a few at a
  time so a laptop survives it, with a warning first when memory is short or the
  port is taken.
- **Merges their logs.** One stream, filtered by level, text, or service, with
  build noise and repeated lines folded away.
- **Finds the source.** Click a line to see the `file:line` that printed it, the
  surrounding code, and its payload — then open it in your editor.
- **Watches several workspaces at once.** Work in one repository while running a
  single service from another; both appear as their own section.

## Requirements

| | |
|---|---|
| **Node** | 20 or newer |
| **OS** | Linux. On macOS it runs, but service detection, per-service memory and process-tree cleanup do nothing. No Windows support. |
| **Port** | 7788 free (`HELMDEV_PORT` to change) |
| **Editor** | `code` on your PATH for click-to-open; any editor via `HELMDEV_EDITOR` |

See [`SETUP.md`](SETUP.md) for a walkthrough, and [`CLAUDE.md`](CLAUDE.md) for the
conventions and the decisions that look odd until you know why.

## Settings

Click the **⚙** next to the title. Two kinds of setting, kept deliberately apart:

| Where | What | Why there |
|---|---|---|
| `settings.json` (next to helm-dev, server-side) | start concurrency, log buffer MB, mute frontends | properties of **this machine**, enforced by the server; must apply with no browser open |
| browser `localStorage` | theme, detail-pane width, level filters, focused services, noise toggle | per-viewer taste; should not follow the machine or affect a colleague |

**Start concurrency** decides how many services may cold-start at once. Each start
runs a webpack build, so the ceiling is RAM and cores, not preference. Left unset
it auto-detects from the machine — `min(4, totalmem/8GB, cores/4)` — which is 3 on
a 12-core/31GB box and 1 on a small laptop. The slider overrides it; the override
is what gets stored, so moving the file to another machine is not a good idea.

`bufferMB` and `muteFrontends` apply immediately. Every setting takes effect
without a restart.

## Timestamps

A record carries **the time the service logged it**, not the time helm-dev read
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
helm-dev restart loses the buffer, and so does restarting a service.

The cap is a **byte budget, not a line count** (`HELMDEV_BUFFER_MB`, default
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
debounce. Change it with `HELMDEV_BUFFER_MB`; the UI shows live usage as
`buffer 12/50MB`.

Stopping helm-dev stops the services it started. It writes the list to
`.cache/session.json` first, so `./helm-dev --resume` brings the same set back.

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
  helm-dev) is implemented but has not been exercised against a live service.
