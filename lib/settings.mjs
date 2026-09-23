import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';

const DEFAULTS = {
  // Each entry is { name, path }. The name is the developer's label, so two
  // worktrees of the same repository can be told apart.
  repos: [],
  activeRepo: null,
  startConcurrency: null, // null means "use the recommendation for this machine"
  bufferMB: 50,
  muteFrontends: true,
};

/**
 * Suggests how many services this machine can cold-start at once. Each `nx serve`
 * runs a webpack build, so the limit is really RAM and cores, not preference.
 * @returns the recommended concurrency, between 1 and 4
 */
export function recommendedConcurrency() {
  // Total memory is the wrong measure: what matters is what is free right now,
  // next to the editor and browser the developer already has open. A cold Nx
  // build needs roughly 3GB, so budget that per parallel start.
  const freeGb = availableGb();
  const byMemory = Math.floor(freeGb / 3);
  const byCores = Math.floor(cpus().length / 4);
  return Math.max(1, Math.min(3, byMemory, byCores));
}

/**
 * Reads memory actually available, falling back to the total when the kernel
 * does not report it.
 * @returns available gigabytes
 */
function availableGb() {
  try {
    const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (match !== null) return Number(match[1]) / 1024 / 1024;
  } catch {
    // Not Linux, or /proc is unavailable.
  }
  return totalmem() / 1024 ** 3;
}

/**
 * Loads the machine-level settings, filling in defaults for anything missing.
 * @param path - absolute path of the settings file
 * @returns the effective settings, with the resolved concurrency
 */
export async function loadSettings(path) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // No settings file yet; defaults apply.
  }
  const merged = { ...DEFAULTS, ...stored };
  return {
    ...merged,
    resolvedConcurrency: merged.startConcurrency ?? recommendedConcurrency(),
    recommended: recommendedConcurrency(),
  };
}

/**
 * Writes machine-level settings, ignoring keys that are not settings.
 * @param path - absolute path of the settings file
 * @param current - the settings in force
 * @param changes - the fields to change
 * @returns the new effective settings
 */
export async function saveSettings(path, current, changes) {
  const next = {};
  for (const key of Object.keys(DEFAULTS)) {
    next[key] = key in changes ? changes[key] : current[key];
  }
  await writeFile(path, JSON.stringify(next, null, 2));
  return {
    ...next,
    resolvedConcurrency: next.startConcurrency ?? recommendedConcurrency(),
    recommended: recommendedConcurrency(),
  };
}
