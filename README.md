<div align="center">
  <img src="public/logo.svg" width="56" alt="" />
  <h1>helm-dev</h1>
  <p><em>A local control panel for Nx monorepos.</em></p>
</div>

Runs your services, merges their logs into one filterable stream, and resolves each
log line back to the source line that printed it — one click from there into your
editor, or into a ready-made Claude prompt.

Built for a working day that looks like this: five services running, one of them
misbehaving, and the line that explains it buried in three thousand others.

**No dependencies. No build step. No install.** Node's standard library only.

---

## Quick start

```bash
git clone git@github.com:kevit-shrut-sureja/helm-dev.git
cd helm-dev && ./helm-dev          # → http://localhost:7788
```

On first run it asks for the path to an Nx workspace — the folder containing
`nx.json`. After that:

```bash
./helm-dev --resume     # restart whatever was running when it last stopped
./helm-dev --reindex    # rebuild the log-site index
```

**It keeps itself up to date.** On start, if `master` has moved on GitHub, it lists the
new commits and asks to update — no answer in 10 seconds counts as yes. It only
fast-forwards a clean checkout of `master`; local changes or another branch are left
alone, and being offline just starts the current version. `HELM_DEV_NO_UPDATE=1`
skips the check.

**Quitting helm-dev stops the services it started.** That is deliberate; it records
them first, which is what `--resume` reads back.

## What it does

- **Runs services** — every Nx project with a `serve` target, started a few at a time
  so a laptop survives it, and it asks first when memory is short or the port is taken.
- **Merges their logs** — one stream, filtered by level, text or service, with build
  noise and repeated lines folded away.
- **Finds the source** — click a line for the `file:line` that printed it, the code
  around it, its payload and its exact timestamp.
- **Watches several workspaces** — work in one repository while running a single
  service from another; each gets its own section.

## Command line — for you and for AI assistants

`helmctl` drives a running helm-dev from a terminal, so a script or an AI assistant
can check on and restart services without the browser. It is only a client of the
same server, so what it shows is exactly what the page shows.

```bash
./helmctl status                       # what is up, on which ports, for how long
./helmctl restart platform-apis        # waits until it is up again, or says why it is not
./helmctl restart --all                # every service that is up
./helmctl logs platform-apis --level error,warn -n 50
./helmctl logs --grep "timeout" --since 10m
./helmctl logs platform --follow --for 30
./helmctl resolve platform "User is authorized on bot"   # the file:line behind a message
```

Link it onto your PATH with `ln -s "$PWD/helmctl" ~/.local/bin/helmctl`. A service is
`name`, or `repo/name` when two workspaces share a name. It exits 0 when done, 1 when
a service failed or timed out, and 2 for bad usage or when helm-dev is not running
(`--port` or `HELMDEV_PORT` picks the server). `helmctl help` lists everything.

**Telling an AI assistant about it:** paste *"This machine runs helm-dev. Use
`./helmctl status`, `./helmctl restart <service>` and `./helmctl logs <service>
--level error` (run `./helmctl help` first) to check on and restart services."*
Output is deliberately short and ends with a summary line.

**Or install the Claude Code skill**, which teaches it all of this (and to ask you once
per chat whether you use helm-dev):

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD/skills/helm-dev" ~/.claude/skills/helm-dev
```

## Requirements

| | |
|---|---|
| **Node** | 20 or newer |
| **OS** | Linux. It runs on macOS, but service detection, per-service memory and process-tree cleanup do nothing there. No Windows support. |
| **Port** | 7788 free |
| **Editor** | `code` on your PATH for click-to-open — any editor works, see below |

## Configuration

Machine settings — workspaces, how many services start at once, buffer size — live in
`settings.json` and are edited through the **⚙** panel. Theme, pane widths and filters
are per-browser. Environment variables override the rest:

| Variable | Default | Purpose |
|---|---|---|
| `HELMDEV_PORT` | `7788` | dashboard port |
| `HELMDEV_ALLOW` | none | who else may connect — see below |
| `HELMDEV_REPO` | first configured workspace | workspace to open |
| `HELMDEV_BUFFER_MB` | `50` | log buffer budget |
| `HELMDEV_EDITOR` | `code -g {file}:{line}` | click-to-open command |
| `HELMDEV_TAIL_DIR` | `<tmp>/helm-dev-logs-<user>` | drop dir for tailed logs |
| `HELMDEV_DETECT_MS` | `8000` | how often to look for services started elsewhere |

### Letting other machines in

By default only this machine can reach the dashboard. To allow others, name them when
you start it (the flag wins over the variable):

```bash
./helm-dev --allow=192.168.1.40,10.0.0.0/24   # one address and one IPv4 range
HELMDEV_ALLOW=192.168.1.40 ./helm-dev
./helm-dev --allow=0.0.0.0                     # anyone who can reach the port
```

This machine is always allowed. Naming anyone else makes it listen on all interfaces;
everyone not on the list gets a 403. `0.0.0.0` means *every* address, so use it only
on a network you trust: the dashboard can start and stop processes and read your
source. It is deliberately not a setting in the page, where a client could widen its
own access. Restart helm-dev for a change to take effect.

### Opening files in your editor

`HELMDEV_EDITOR` is a command template: `{file}` becomes the absolute path and
`{line}` the line number, then it is run as given — so any editor with a CLI works.

```bash
# JetBrains WebStorm
HELMDEV_EDITOR='webstorm --line {line} {file}' ./helm-dev

# IntelliJ IDEA / PhpStorm / PyCharm — same flag, different binary
HELMDEV_EDITOR='idea --line {line} {file}' ./helm-dev

# Sublime Text
HELMDEV_EDITOR='subl {file}:{line}' ./helm-dev

# Zed
HELMDEV_EDITOR='zed {file}:{line}' ./helm-dev

# VS Code (the default)
HELMDEV_EDITOR='code -g {file}:{line}' ./helm-dev
```

For WebStorm, the `webstorm` launcher comes from **JetBrains Toolbox → WebStorm →
Settings → Generate shell scripts**, or **Tools → Create Command-line Launcher** inside
the IDE. Check it works before relying on it:

```bash
webstorm --line 1 /etc/hostname     # should open that file in the running IDE
```

Zed's CLI is usually on PATH once it's installed, but not always — check first:

```bash
zed --version   # command not found? add ~/.local/bin to PATH, or the binary may
                # be named zeditor on some Linux packages — check your install
```

To keep it, put the variable in your shell profile instead of typing it each time:

```bash
echo "export HELMDEV_EDITOR='webstorm --line {line} {file}'" >> ~/.zshrc
```

## Further reading

- [`SETUP.md`](SETUP.md) — first-run walkthrough and troubleshooting
- [`FEATURES.md`](FEATURES.md) — every feature: when it applies, when it does not,
  and why
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how a service gets run, how its logs
  reach the page, and where each piece of state lives
- [`CLAUDE.md`](CLAUDE.md) — conventions, and the decisions that look wrong until you
  know the measurement behind them
