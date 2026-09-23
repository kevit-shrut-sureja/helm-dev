import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';

const DEFAULTS = {
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
  const byMemory = Math.floor(totalmem() / (8 * 1024 ** 3));
  const byCores = Math.floor(cpus().length / 4);
  return Math.max(1, Math.min(4, byMemory, byCores));
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
