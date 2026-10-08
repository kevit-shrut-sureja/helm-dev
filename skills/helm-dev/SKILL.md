---
name: helm-dev
description: Check on, restart and read logs from local Nx services through helm-dev's `helmctl` command line. Use when the user is running or debugging local backend services (chatomate, ttl-omni, platform, platform-apis and the like), asks why a service is down or failing, wants a service restarted after a code change, asks what a service logged, or wants a log message traced back to the source line. Asks once per chat whether they use helm-dev before relying on it.
---

# helm-dev — services and logs through `helmctl`

helm-dev is the user's local control panel for Nx monorepos. It starts and stops
services, keeps their recent logs in memory, and knows which source line printed
each one. `helmctl` is its command line: the same data the browser page shows,
without needing the browser.

## Ask once, then stick to the answer

The first time in a chat that this would help — the user is debugging a local
service, wants one restarted, or asks what a service logged — **ask once**:

> Are you running these through helm-dev? If so I can check status, restart them and read their logs with `helmctl`.

- **Yes** → use `helmctl` for the rest of the chat. Don't ask again.
- **No**, or they ignore it → carry on the way you would have, and don't raise it again.
- Never ask for unrelated work, and never ask twice.

After a yes, `helmctl status` confirms it is reachable. Exit code 2 and "helm-dev is
not running" means the server is down: tell the user to start it with `./helm-dev`
(in their helm-dev folder) rather than starting services some other way.

## Finding the command

```bash
command -v helmctl || ls ~/work/helm-dev/helmctl
```

Run it from wherever that points (`~/work/helm-dev/helmctl` on this machine). If it
is missing, ask where helm-dev is checked out. Run `helmctl help` once if you are
unsure of a flag — it is short.

## What you can do

| Goal | Command |
|---|---|
| What is up, on which ports, for how long | `helmctl status` (add `--all` to include stopped, `--json` to parse) |
| Why did it fail | `helmctl status <service>` shows the reason; then `helmctl logs <service> --level error,warn -n 30` |
| Restart one service after an edit | `helmctl restart <service>` — waits until it is up, or prints why not |
| Start or stop | `helmctl start <service>` / `helmctl stop <service>` |
| Recent errors anywhere | `helmctl logs --level error --since 10m` |
| Search logs | `helmctl logs --grep "timeout" --since 30m` (also searches structured fields such as ids) |
| Watch live | `helmctl logs <service> --follow --for 30` |
| Which line printed this | `helmctl resolve <service> "<message text>"` → `file:line` |

A service is `name`, or `repo/name` when the same name exists in two workspaces
(`ikit` is in both chatomate and ttl). Say `chatomate/ikit`.

## How to get the data you need

**"Is it up?"** — `helmctl status`. `running` with a port means it is listening.
`running … (assumed up)` means nothing was seen listening; treat it as unverified.
`failed` includes the reason. `queued` means it is waiting its turn to boot.

**"What went wrong after I restarted it?"** — restart, which prints the result, then:
`helmctl logs <service> --since 2m --level error,warn`. Logs older than the
restart belong to the previous process, so use `--since` rather than `-n` alone.

**"Did my change take effect?"** — restart the service, wait for `running`, trigger
the code path, then `helmctl logs <service> --since 1m --grep "<something your change logs>"`.

**Tracing one request** — find a line with an id, then
`helmctl logs --grep "<the id>" --since 1h` across all services.

**From a log line to the code** — `helmctl resolve <service> "<exact message>"`.
Use the service that printed it. It reports `exact`, `pattern` or `ambiguous`; treat
`ambiguous` as a shortlist, and "no source line found" as genuinely unknown — do not
guess a file. Pass `--context ClassName` when the line shows one.

**Structured payloads** — add `--fields` to see the JSON that came with a line, and
`--full` to stop long messages being cut at 400 characters. `--json` gives one record
per line for parsing.

## Things to know

- **Logs are recent and in memory.** The buffer holds a limited window (tens of MB).
  Empty output may mean the line scrolled out or the service was never started, not
  that nothing happened. A restart of helm-dev itself empties it.
- **Backends do not reload by themselves.** After editing a service's source,
  restart it. A frontend started with live reload rebuilds on its own.
- **Restarts are slow and heavy.** Each start is a webpack build. `restart --all`
  rebuilds everything that is up, a few at a time — **ask before running it** unless
  the user asked for it. Never pass `--force` to `start` (it skips the memory and
  port warnings) without the user's say-so.
- **A refused start is information.** "Port 3500 is already held by …" or a memory
  warning means something real; report it instead of forcing past it.
- **`failed` services** need `restart`, not `start`.
- **Services started outside helm-dev** show as `external`. `stop` works on them,
  `restart --all` skips them.
- **Long waits.** `start` and `restart` wait up to 3 minutes by default
  (`--timeout`, or `--no-wait` to return at once). Run them normally; they report
  when done.

## Exit codes

`0` done · `1` a service failed or timed out · `2` bad usage, unknown service, or
helm-dev not running. A line starting `-- N line(s) — more exist` means the output
was capped: narrow it with `--since`, `--level` or `--grep` instead of raising `-n`
a lot.

## Reporting back

State what you ran and what it returned in plain words — which service, what status,
what the error line said, and the `file:line` if you resolved one. Quote the log
line itself when it is the evidence. If you restarted something, say so.
