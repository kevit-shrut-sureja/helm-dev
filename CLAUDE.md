# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`helm-dev` is a local control panel for Nx monorepos. It starts and stops services,
merges their logs into one filterable stream, and resolves each log line back to the
source line that printed it — one click from there into an editor.

It is a **development tool that runs on a developer's own machine**. Two consequences
shape every decision here:

- **It must not slow the machine down.** It sits beside an editor, a browser and
  several heavy services. Footprint is a feature, not a detail.
- **It must never lie about state.** A service reported as running when it is not, or
  a log line attributed to the wrong source, is worse than showing nothing.

## Running it

```bash
./helm-dev            # http://localhost:7788
./helm-dev --resume   # also restart whatever was running when it last stopped
./helm-dev --reindex  # rebuild the log-site index from scratch
```

No install step. **No dependencies, and it must stay that way** — Node's standard
library only, no build, no bundler, no framework. If something seems to need a
package, that is a signal to reconsider the approach.

## Layout

```
helm-dev            entry script (node with tuned heap flags)
server.mjs          HTTP + SSE, routes, workspace lifecycle
check.mjs           static check: broken references between the files below
smoke.mjs           boots the page's modules in Node against a running instance

lib/workspace.mjs   one watched repository and everything derived from it
lib/runner.mjs      spawns nx serve, parses log formats, boot/failure states
lib/log-index.mjs   builds and queries the log-site index
lib/projects.mjs    discovers and classifies Nx projects
lib/detect.mjs      finds services started outside helm-dev
lib/watcher.mjs     source watching for staleness
lib/preflight.mjs   memory and port checks before a start
lib/stats.mjs       per-service memory, git state
lib/tailer.mjs      tails <service>.log drop files

public/index.html   the page, and the only place the modules are listed
public/app.js       boot: load state, paint, subscribe, hand over
public/core.js      shared state, the element map, helpers
public/services.js  the sidebar: what runs, and the controls that change it
public/workspaces.js  adding, removing and reordering repositories
public/filters.js   what reaches the log pane, and the chips that say so
public/logs.js      the virtualised log pane
public/detail.js    the pane that opens on a line
public/panels.js    settings, help, and closing them on a click away
public/layout.js    theme and the draggable dividers
public/styles/      one stylesheet per area, loaded in the order index.html lists
```

ES modules, loaded natively — no bundler, and `<script type="module">` already
defers them, so the DOM is ready when any of them runs.

## Conventions

- **ES modules, `.mjs` on the server**, plain `.js` for the page. Node 20+.
- **JSDoc on every function**: one line saying why it exists, then `@param`/`@returns`.
  No type annotations in the JSDoc — this is JavaScript, the signature says enough.
- **Comments explain why, never what.** Most comments here record a non-obvious
  constraint discovered the hard way. Do not remove them to tidy up; they are the
  reason the code is shaped as it is.
- `const`/`let` only, `===` only, early returns over nesting.
- Errors are swallowed only where degrading is correct (a directory that cannot be
  watched, a `/proc` read on a non-Linux machine) and the empty `catch` says so.

## Things that look wrong but are deliberate

- **`--output-style=stream-without-prefixes`** when spawning. Nx's default `static`
  style buffers a task's entire output until it finishes, which for a long-running
  `serve` means no logs at all. `stream` flushes live; the suffix stops Nx prefixing
  every line with the project name, which would break log→source matching.
- **Readiness comes from a listening port**, not from log text, and the listening pid
  must belong to that service's process tree. Matching startup messages broke across
  repositories, and an orphaned process on the right port once confirmed a service
  that had not started.
- **One shared recursive watch over `libs/`**, not one per dependency. A service here
  imports ~66 libraries; one `fs.watch` each meant ~335 inotify instances for five
  services, over the default limit on many Linux setups.
- **The index is built in a child process** that then exits. Scanning ~6k files leaves
  enough garbage to raise the long-running server's RSS by tens of megabytes.
- **Frontends are started with `--watch=false --liveReload=false`** unless live mode is
  asked for. Angular's watcher costs gigabytes.
- **Nx keeps a failed or finished task alive.** A job that completes is detected from
  Nx's own `Process exited with code N` line, not from the child exiting.
- **The page's modules import each other in cycles** — `logs` ↔ `detail`,
  `logs` ↔ `filters`. Every one of those references is inside a function that runs
  after boot, which ES modules handle; splitting them further to break the cycle
  would only move the coupling somewhere less obvious.
- **The buffers evict in batches, not per line.** Dropping one record per arriving
  line moves the whole array each time: 121ms per 1000 lines on a full 50MB buffer,
  against 0.9ms when evicting down to a low-water mark. Both the server and the tab
  do it the same way.
- **The page writes layout once per frame, never per line.** `appendLog` only sets a
  flag; the spacer, the counter and the follow position are written inside the
  animation frame. The follow position is computed from the row count rather than
  read back as `scrollHeight`, because reading layout straight after writing it
  forces a synchronous reflow — which used to happen on every log line.
- **Log frames are coalesced over 16ms; status frames are not.** A burst of hundreds
  of lines becomes one write, but anything the UI reacts to goes out immediately and
  takes the waiting log lines with it, so order is never disturbed.
- **Stylesheet order is load-bearing.** `index.html` lists them in cascade order and
  a few selectors are deliberately restated later. Moving a block between files can
  change what wins without changing a single declaration.
- **`LogSiteIndex.resolve()` memoizes, capped at 2000 entries.** An exact-match
  message resolves in under a microsecond regardless — the index is a Map lookup.
  A message that falls through to pattern matching costs ~130µs, measured against
  chatomate's real index (1429 patterns, 206 prefixes, full linear scan on a miss).
  Cheap for one click; wasteful for the same recurring error clicked into twice,
  which is the normal shape of debugging with this tool. The cache is capped
  because messages carrying dynamic values (an order id, a request id) mint a
  distinct key each time — unbounded would grow with the session. It needs no
  invalidation: `reindex()` always builds a new `LogSiteIndex` instance rather
  than mutating the old one, so a stale cache cannot outlive the index it caches.

## Testing changes

Two checks, then your eyes. Run both before committing:

```bash
node check.mjs      # static: nothing refers to something that is gone
node smoke.mjs      # boots the page's modules against a running instance
node e2e.mjs         # full run: starts its own helm-dev, exercises every route
                      # and the real log pipeline, then runs smoke.mjs against it
```

`check.mjs` exists because every serious bug here has been the same one: an edit
replaced a block and silently dropped something the rest still used. It has
caught four missing API routes, a page of missing CSS and two deleted functions,
each of which had been broken for days. It fails when the page calls an endpoint
the server does not serve, emits a class no stylesheet defines, calls a function
declared nowhere, imports something not exported, or leaves a module nothing
imports (`layout.js` sat dead for a day this way — nothing was missing, so nothing
caught it until this check learned to ask whether each module is reachable).

`e2e.mjs` starts a throwaway helm-dev on a free port, with its own tail directory
and a 1MB buffer so eviction is actually exercised, and tears it down with
`SIGKILL` so it never gets recorded as the session to `--resume`. It restores
whatever presets were saved before it ran. It is the one that catches a route
that answers but answers wrong — `check.mjs` only knows a route exists.

Then verify against a real workspace:

1. start a service and watch it reach `running` — not `unconfirmed`
2. click a log line and confirm it resolves to the right `file:line`
3. trace an id from that line and confirm the buffer filters to it
4. stop it and confirm it does not reappear as "started outside helm-dev"
5. check the footprint in the header has not grown

**The server does not reload.** Changing `server.mjs` or `lib/` means restarting
`./helm-dev`; only `public/` is picked up by refreshing the page. The page says so
itself when it gets a 404 from a route it knows about.

Measure rather than assume. Most of the decisions above came from a number that
contradicted an assumption.
