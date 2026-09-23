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
lib/workspace.mjs   one watched repository and everything derived from it
lib/runner.mjs      spawns nx serve, parses log formats, boot/failure states
lib/log-index.mjs   builds and queries the log-site index
lib/projects.mjs    discovers and classifies Nx projects
lib/detect.mjs      finds services started outside helm-dev
lib/watcher.mjs     source watching for staleness
lib/preflight.mjs   memory and port checks before a start
lib/stats.mjs       per-service memory, git state
lib/tailer.mjs      tails <service>.log drop files
public/             single page, vanilla JS, no framework
```

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

## Testing changes

There is no test suite. Verify against a real workspace:

1. start a service and watch it reach `running` — not `unconfirmed`
2. click a log line and confirm it resolves to the right `file:line`
3. stop it and confirm it does not reappear as "started outside helm-dev"
4. check the footprint in the header has not grown

Measure rather than assume. Most of the decisions above came from a number that
contradicted an assumption.
