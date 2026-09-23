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
| `HELMDEV_REPO` | first configured workspace | workspace to open |
| `HELMDEV_BUFFER_MB` | `50` | log buffer budget |
| `HELMDEV_EDITOR` | `code -g {file}:{line}` | click-to-open command |
| `HELMDEV_TAIL_DIR` | `<tmp>/helm-dev-logs-<user>` | drop dir for tailed logs |

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

# VS Code (the default)
HELMDEV_EDITOR='code -g {file}:{line}' ./helm-dev
```

For WebStorm, the `webstorm` launcher comes from **JetBrains Toolbox → WebStorm →
Settings → Generate shell scripts**, or **Tools → Create Command-line Launcher** inside
the IDE. Check it works before relying on it:

```bash
webstorm --line 1 /etc/hostname     # should open that file in the running IDE
```

To keep it, put the variable in your shell profile instead of typing it each time:

```bash
echo "export HELMDEV_EDITOR='webstorm --line {line} {file}'" >> ~/.zshrc
```

## Further reading

- [`SETUP.md`](SETUP.md) — first-run walkthrough and troubleshooting
- [`CLAUDE.md`](CLAUDE.md) — conventions, and the decisions that look wrong until you
  know the measurement behind them
