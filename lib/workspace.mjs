import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { discoverProjects } from './projects.mjs';
import { loadIndex } from './log-index.mjs';
import { ServiceRunner } from './runner.mjs';
import { SourceWatcher } from './watcher.mjs';
import { detectExternal } from './detect.mjs';
import { listeners } from './preflight.mjs';

/**
 * One watched repository and everything derived from it. Service names repeat
 * across repositories — both forks have an `ikit` — so every record this emits
 * carries the workspace it came from, and callers address services by the pair.
 */
// Anything that isn't "up" has nothing left to watch for. `stopping` is left
// out deliberately — the watch is only released once the service has actually
// gone, not the moment someone asked it to.
const TERMINAL_STATUSES = new Set(['failed', 'completed', 'stopped']);

export class Workspace extends EventEmitter {
  #cacheDir;

  constructor(name, root, cacheDir) {
    super();
    this.name = name;
    this.root = root;
    this.#cacheDir = cacheDir;
    this.runner = new ServiceRunner(root);
    this.watcher = new SourceWatcher(root);
    this.projects = [];
    this.projectNames = new Set();
    this.index = null;
    this.external = {};
    // Ports each service was last seen listening on. Learned from real runs, so
    // unlike a config file it cannot describe a port the service no longer uses.
    this.knownPorts = new Map();
  }

  /**
   * Discovers the workspace's projects and builds its log-site index.
   * @param options - `reindex` forces the index to be rebuilt
   */
  async init(options = {}) {
    this.projects = await discoverProjects(this.root);
    this.projectNames = new Set(this.projects.map((project) => project.name));
    this.index = await loadIndex(this.root, this.#cachePath(), options.reindex === true);
    await this.#loadPorts();

    this.runner.on('log', (record) => this.emit('log', { ...record, repo: this.name }));
    this.runner.on('status', (status) => {
      // The explicit stop routes already untrack immediately, before the process
      // has actually died — this is what covers everything else: a crash nobody
      // clicked stop on, and a completed job, which stop() refuses to touch at
      // all once it is done. Without this, either left the watch open forever;
      // a service restarted a few times over a session was leaking one watch
      // per attempt. untrack() is a no-op if it was already released.
      if (TERMINAL_STATUSES.has(status.status)) this.watcher.untrack(status.service);
      this.emit('status', { ...status, repo: this.name });
    });
    this.watcher.on('stale', (event) => this.emit('stale', { ...event, repo: this.name }));
  }

  /**
   * Rebuilds the log-site index, after a branch change or an edit.
   * @returns the new index metadata
   */
  async reindex() {
    this.index = await loadIndex(this.root, this.#cachePath(), true);
    return this.index.meta;
  }

  /**
   * Looks up one of this workspace's projects.
   * @param name - the project name
   * @returns the project, or undefined
   */
  project(name) {
    return this.projects.find((project) => project.name === name);
  }

  /**
   * Re-scans for services of this workspace started outside helm-dev.
   * @returns true when the set changed
   */
  async refreshExternal() {
    const found = await detectExternal(this.root, this.projectNames);
    const owned = this.runner.statuses();
    // A process helm-dev has just signalled may take seconds to die. Until then
    // it is still ours, not something a developer started in a terminal.
    const dying = this.runner.recentlySignalled();
    for (const name of Object.keys(found)) {
      const mine = owned[name];
      if (dying.has(found[name].pid)) delete found[name];
      else if (mine && (mine.status !== 'stopped' || mine.pid === found[name].pid)) delete found[name];
    }
    const changed = JSON.stringify(found) !== JSON.stringify(this.external);
    this.external = found;
    return changed;
  }

  /**
   * Begins watching a service's sources. Frontends are skipped: their dev server
   * rebuilds itself, so a stale badge would never be true.
   * @param name - the project name
   */
  async watchSources(name) {
    const project = this.project(name);
    if (!project?.sourceRoot || project.kind === 'frontend') return;
    await this.watcher.track(name, project.sourceRoot);
  }

  /**
   * Confirms services by checking whether they are listening. A port is evidence;
   * a log line saying "started" is only a convention, and it varies between
   * repositories, frameworks and versions. Which port is never configured: it is
   * whatever the service's own process tree is found listening on.
   */
  async confirmBooting() {
    const waiting = this.runner.awaitingConfirmation();
    if (waiting.length === 0) return;

    const snapshot = await listeners();
    for (const name of waiting) {
      const ports = this.runner.listeningPorts(name, snapshot);
      if (ports.length === 0) continue;
      this.runner.confirmListening(name, ports);
      await this.#rememberPorts(name, ports);
    }
  }

  /**
   * Stops everything this workspace is running and releases its watches.
   * @returns the names of the services that were stopped
   */
  dispose() {
    const stopped = this.runner.stopAll();
    for (const name of Object.keys(this.watcher.staleness())) this.watcher.untrack(name);
    this.runner.removeAllListeners();
    this.watcher.removeAllListeners();
    return stopped;
  }

  /**
   * Reads the ports remembered from earlier runs of this workspace's services.
   */
  async #loadPorts() {
    try {
      const saved = JSON.parse(await readFile(this.#portsPath(), 'utf8'));
      this.knownPorts = new Map(Object.entries(saved));
    } catch {
      // Nothing remembered yet; the first start of each service teaches it.
    }
  }

  /**
   * Records a service's ports, writing only when they changed.
   * @param name - the project name
   * @param ports - the ports it was seen listening on
   */
  async #rememberPorts(name, ports) {
    if (JSON.stringify(this.knownPorts.get(name)) === JSON.stringify(ports)) return;
    this.knownPorts.set(name, ports);
    await writeFile(this.#portsPath(), JSON.stringify(Object.fromEntries(this.knownPorts))).catch(() => undefined);
  }

  #portsPath() {
    return this.#cachePath().replace('log-sites-', 'ports-');
  }

  #cachePath() {
    const slug = this.root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    return join(this.#cacheDir, `log-sites-${slug}.json`);
  }
}
