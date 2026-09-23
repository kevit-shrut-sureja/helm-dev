# devscope — setup

A local log console for this monorepo. It starts services, merges their logs into
one filterable stream, and resolves any log line back to the source line that
printed it — one click from there into your editor.

Nothing is installed. No `npm install`, no build step, no dependencies.

---

## 1. Requirements

| | |
|---|---|
| **Node** | 20 or newer (`node -v`) — the same one you build the repo with |
| **OS** | Linux. On macOS it runs, but service detection, per-service memory and process-tree cleanup quietly do nothing. No Windows support. |
| **Port** | 7788 free (change it with `DEVSCOPE_PORT`) |
| **Editor** | `code` on your PATH for click-to-open. Any other editor works — see step 5. |

## 2. Install

Put the folder inside your checkout of the repo, at this exact path:

```
<your-repo>/tmp/devscope
```

It locates the repo by walking up for `nx.json`, so that path needs no configuring.
`tmp/` is already in the repo's `.gitignore`, so it never reaches git.

If the folder came from a teammate, delete their `.cache` folder inside it first —
it holds a 2MB index and a session file from their machine. It rebuilds in under a
second. (Leaving it does no harm: the index records which repo path and commit it
was built from, and rebuilds itself when either differs.)

## 3. Run

```bash
cd tmp/devscope
./run.sh                 # then open http://localhost:7788
```

If `./run.sh` says permission denied, the copy lost its executable bit:
`chmod +x run.sh`.

Once you have used it a while, this is the one to remember:

```bash
./run.sh --resume        # restart whatever was running when you last quit
```

**Quitting devscope stops the services it started.** That is deliberate — it writes
the list to `.cache/session.json` first, which is what `--resume` reads.

## 4. First five minutes

- The left column lists every Nx project with a `serve` target. Press **▶** to start
  one. Services boot **a few at a time** (auto-detected from your machine), so
  clicking ten of them will not bring your laptop down.
- **Click a service's name** to show only its logs. Clicking the name never starts
  or stops anything — that is **▶**, **⟳** (restart) and **×** (stop).
- Frontends have a second button, **▶L**, which starts them with live reload.
  That costs gigabytes of RAM, so plain **▶** switches watching off.
- The **noise** button hides Nest bootstrap and Nx build output — about 78% of a
  typical session. Your own `console.log` lines are *not* noise; they sit under the
  **raw** level button.
- **Click any log line** for its payload, its exact timestamp, and the `file:line`
  that printed it, with **open in VSCode** and **copy Claude prompt**.
- Identical consecutive lines fold into one row with a `×N` badge — click the badge
  to expand them.
- Press **?** for keyboard shortcuts. Nothing destructive is bound to a key, and
  `Ctrl`/`Cmd`/`Alt` combinations always belong to the browser.

## 5. Configuration

Machine settings live in `settings.json` next to devscope and are edited through the
**⚙** button: how many services may start at once, the log buffer size, and whether
frontend logs are muted. Your theme, filters and pane width are per-browser and kept
in the browser.

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `DEVSCOPE_PORT` | `7788` | dashboard port |
| `DEVSCOPE_REPO` | nearest `nx.json` above the cwd | repo to watch |
| `DEVSCOPE_BUFFER_MB` | `50` | log buffer budget |
| `DEVSCOPE_EDITOR` | `code -g {file}:{line}` | click-to-open command |
| `DEVSCOPE_TAIL_DIR` | `<tmp>/devscope-logs-<user>` | drop dir for tailed logs |

Not a VSCode user:

```bash
DEVSCOPE_EDITOR='idea --line {line} {file}' ./run.sh
```

## 6. If something looks wrong

**"Port 7788 is already in use"** — devscope is already running. Find it with
`ss -lptn 'sport = :7788'`.

**A service has a blue dot and no logs** — you started it in a terminal, not in
devscope, so its output goes to that terminal. Either press **⟳** to restart it
under devscope, or keep your terminal and tee into the drop dir:
`npm start ikit 2>&1 | tee <tmp>/devscope-logs-<user>/ikit.log`

**A service says "boot failed"** — the reason is on the row and in the log pane.
Switch on **raw** and **noise** to see the whole build output.

**A log line says "not found"** — it came from `node_modules` (Nest's own logging),
from the build, or from a third-party warning. If it says **ambiguous**, that exact
message is logged from several places and every candidate is listed for you to pick.

**Line numbers look off after switching branches** — press **reindex**. It also
rebuilds itself when the commit changes.

---

`README.md` next to this file goes deeper: how log→source resolution works, what it
cannot do, the memory measurements behind the defaults, and why frontends and
backends are treated differently.
