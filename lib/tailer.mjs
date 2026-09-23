import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { finaliseRecord, toRecord } from './runner.mjs';

const ANSI = /\u001b\[[0-9;]*m/g;
const POLL_MS = 400;

/**
 * Tails `<service>.log` files in a drop directory, so services started in a
 * terminal can stream into helm-dev without being restarted under it.
 */
export class LogTailer extends EventEmitter {
  #dir;
  #offsets = new Map();
  #pending = new Map();
  #timer = null;

  constructor(dir) {
    super();
    this.#dir = dir;
  }

  /**
   * Creates the drop directory and begins watching it.
   * @returns the directory being watched
   */
  async start() {
    await mkdir(this.#dir, { recursive: true });
    await this.#sweep();
    this.#timer = setInterval(() => {
      this.#sweep().catch(() => undefined);
    }, POLL_MS);
    watch(this.#dir, () => {
      this.#sweep().catch(() => undefined);
    });
    return this.#dir;
  }

  /**
   * Lists the services currently backed by a tailed file.
   * @returns the service names being tailed
   */
  tailed() {
    return [...this.#offsets.keys()];
  }

  async #sweep() {
    let files;
    try {
      files = await readdir(this.#dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (file.endsWith('.log')) await this.#readNew(join(this.#dir, file));
    }
  }

  async #readNew(path) {
    const service = basename(path, '.log');
    const info = await stat(path).catch(() => null);
    if (info === null) return;

    const previous = this.#offsets.get(service) ?? 0;
    // A shrinking file means the dev restarted the service and truncated the log.
    const from = info.size < previous ? 0 : previous;
    if (info.size === from) {
      this.#offsets.set(service, info.size);
      return;
    }

    const handle = await open(path, 'r');
    try {
      const length = info.size - from;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, from);
      this.#offsets.set(service, info.size);
      this.#consume(service, buffer.toString());
    } finally {
      await handle.close();
    }
  }

  #consume(service, text) {
    const held = this.#pending.get(service) ?? { partial: '', record: null, continuation: [] };
    const lines = (held.partial + text).split('\n');
    held.partial = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const clean = line.replace(ANSI, '');
      if (/^\s/.test(clean) && held.record !== null) {
        held.continuation.push(clean);
        continue;
      }
      if (held.record !== null) this.emit('log', finaliseRecord(held.record, held.continuation));
      held.record = toRecord(service, 'tail', clean);
      held.continuation = [];
    }

    if (held.record !== null && held.partial.length === 0) {
      this.emit('log', finaliseRecord(held.record, held.continuation));
      held.record = null;
      held.continuation = [];
    }
    this.#pending.set(service, held);
  }
}
