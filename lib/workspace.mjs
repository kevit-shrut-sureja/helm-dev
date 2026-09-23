import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { discoverProjects } from './projects.mjs';
import { loadIndex } from './log-index.mjs';
import { ServiceRunner } from './runner.mjs';
import { SourceWatcher } from './watcher.mjs';
import { detectExternal } from './detect.mjs';

/**
 * One watched repository and everything derived from it. Service names repeat
 * across repositories — both forks have an `ikit` — so every record this emits
 * carries the workspace it came from, and callers address services by the pair.
 */
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
  }

  /**
   * Discovers the workspace's projects and builds its log-site index.
   * @param options - `reindex` forces the index to be rebuilt
   */
  async init(options = {}) {
    this.projects = await discoverProjects(this.root);
    this.projectNames = new Set(this.projects.map((project) => project.name));
    this.index = await loadIndex(this.root, this.#cachePath(), options.reindex === true);

    this.runner.on('log', (record) => this.emit('log', { ...record, repo: this.name }));
    this.runner.on('status', (status) => this.emit('status', { ...status, repo: this.name }));
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
   * Re-scans for services of this workspace started outside devscope.
   * @returns true when the set changed
   */
  async refreshExternal() {
    const found = await detectExternal(this.root, this.projectNames);
    const owned = this.runner.statuses();
    for (const name of Object.keys(found)) {
      const mine = owned[name];
      if (mine && (mine.status !== 'stopped' || mine.pid === found[name].pid)) delete found[name];
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

  #cachePath() {
    const slug = this.root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    return join(this.#cacheDir, `log-sites-${slug}.json`);
  }
}
