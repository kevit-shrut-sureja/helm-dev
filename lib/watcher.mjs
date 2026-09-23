import { EventEmitter } from 'node:events';
import { existsSync, watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.nx', 'coverage']);
const IMPORT_RE = /@chatomate\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)/g;
const DEBOUNCE_MS = 250;

/**
 * Collects the TypeScript sources under a directory.
 * @param dir - absolute directory to walk
 * @returns absolute paths of the sources found
 */
async function collect(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...(await collect(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Works out which shared libraries a service imports, so a change in one marks it stale too.
 * @param repoRoot - absolute path to the monorepo root
 * @param sourceRoot - the service's repo-relative source root
 * @returns absolute paths of the library directories the service depends on
 */
export async function resolveDependencies(repoRoot, sourceRoot) {
  const files = await collect(join(repoRoot, sourceRoot));
  const aliases = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    let match = IMPORT_RE.exec(text);
    while (match !== null) {
      aliases.add(match[1]);
      match = IMPORT_RE.exec(text);
    }
  }
  const dirs = [];
  for (const alias of aliases) {
    const candidate = join(repoRoot, 'libs', alias);
    if (existsSync(candidate)) dirs.push(candidate);
  }
  return dirs;
}

/**
 * Watches each running service's sources and its shared libraries, flagging the
 * service as stale once a file changes after it started.
 */
export class SourceWatcher extends EventEmitter {
  #repoRoot;
  #watched = new Map();
  #shared = new Map();

  constructor(repoRoot) {
    super();
    this.#repoRoot = repoRoot;
  }

  /**
   * Opens one recursive watch per directory and fans changes out to every
   * service that depends on it, so ten services sharing a lib cost one watch.
   * @param dir - absolute directory to watch
   * @param name - the service registering interest
   */
  #share(dir, name) {
    let slot = this.#shared.get(dir);
    if (!slot) {
      const subscribers = new Set();
      try {
        const handle = watch(dir, { recursive: true }, (_event, file) => {
          if (typeof file !== 'string' || !/\.(ts|html|scss|json)$/.test(file)) return;
          const changed = relative(this.#repoRoot, join(dir, file));
          for (const subscriber of subscribers) this.#record(subscriber, changed);
        });
        slot = { handle, subscribers };
      } catch {
        return; // A directory that cannot be watched contributes no staleness signal.
      }
      this.#shared.set(dir, slot);
    }
    slot.subscribers.add(name);
  }

  /**
   * Drops a service's interest in a directory, closing the watch when nobody is left.
   * @param dir - the watched directory
   * @param name - the service releasing it
   */
  #release(dir, name) {
    const slot = this.#shared.get(dir);
    if (!slot) return;
    slot.subscribers.delete(name);
    if (slot.subscribers.size === 0) {
      slot.handle.close();
      this.#shared.delete(dir);
    }
  }

  /**
   * Records a changed file against a service and emits a debounced stale event.
   * @param name - the service the change affects
   * @param changed - the repo-relative path that changed
   */
  #record(name, changed) {
    const entry = this.#watched.get(name);
    if (!entry) return;
    entry.changed.add(changed);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.emit('stale', { service: name, changed: [...entry.changed].slice(0, 25) });
    }, DEBOUNCE_MS);
  }

  /**
   * Reports which services have unbuilt source changes.
   * @returns a map of service name to its changed file list
   */
  staleness() {
    const out = {};
    for (const [name, entry] of this.#watched) {
      out[name] = { stale: entry.changed.size > 0, changed: [...entry.changed].slice(0, 25) };
    }
    return out;
  }

  /**
   * Starts watching a service's sources, replacing any previous watch for it.
   * @param name - the project name
   * @param sourceRoot - the service's repo-relative source root
   */
  async track(name, sourceRoot) {
    this.untrack(name);
    const roots = [join(this.#repoRoot, sourceRoot), ...(await resolveDependencies(this.#repoRoot, sourceRoot))];
    this.#watched.set(name, { changed: new Set(), roots, timer: null });
    for (const root of roots) this.#share(root, name);
  }

  /**
   * Stops watching a service and clears its change list.
   * @param name - the project name
   */
  untrack(name) {
    const entry = this.#watched.get(name);
    if (!entry) return;
    clearTimeout(entry.timer);
    for (const root of entry.roots) this.#release(root, name);
    this.#watched.delete(name);
  }

  /**
   * Reports how many directory watches are open, for the footprint readout.
   * @returns the number of shared watches
   */
  watchCount() {
    return this.#shared.size;
  }
}
