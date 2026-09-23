import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.nx']);

// Used only where a repo sets no Nx tags. Both Chatomate and the TTL fork share
// these names; extend the lists if a project is added to one and not the other.
const KNOWN_JOBS = new Set([
  'archivist',
  'db-backup-worker',
  'excalibur',
  'insta-publisher',
  'meta-platform-reconciliation',
  'rcs-jio-reporter',
  'reporter',
  'sms-reporter',
  'social-media-publisher',
  'sync-bridge',
  'sync-external-usage',
  'wa-analytics-worker',
  'wa-reporter',
]);

const KNOWN_FRONTENDS = new Set([
  'admin-panel',
  'app-panel',
  'flow-services-frontend',
  'partner-panel',
  'shopify-frontend',
  'zoho-crm-extension-frontend',
  'zoho-desk-extension-frontend',
]);

/**
 * Walks a directory tree collecting every project.json path.
 * @param dir - absolute directory to walk
 * @param depth - remaining levels to descend
 * @returns absolute paths of the project.json files found
 */
async function findProjectFiles(dir, depth) {
  if (depth < 0) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.name === 'project.json') found.push(join(dir, entry.name));
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      found.push(...(await findProjectFiles(join(dir, entry.name), depth - 1)));
    }
  }
  return found;
}

/**
 * Classifies a project from its Nx tags, falling back to the serve executor and
 * the project's location for repos that do not tag.
 * @param raw - the parsed project.json
 * @returns one of app, job or frontend
 */
function classify(raw) {
  // Nx tags are the intended answer, so they win wherever a repo sets them.
  const tags = raw.tags ?? [];
  if (tags.includes('type:frontend')) return 'frontend';
  if (tags.includes('type:job')) return 'job';
  if (tags.includes('type:app')) return 'app';

  // Untagged repos fall back to what we already know: Chatomate and the TTL fork
  // carry nearly the same set of projects under the same names.
  if (KNOWN_JOBS.has(raw.name)) return 'job';
  if (KNOWN_FRONTENDS.has(raw.name)) return 'frontend';

  // Then the generic signals, so a project nobody listed still lands sensibly:
  // the serve executor decides whether a stack can live-reload, and jobs live
  // under a jobs/ directory.
  const executor = raw.targets?.serve?.executor ?? '';
  if (/dev-server|@angular|vite|webpack-dev/i.test(executor)) return 'frontend';
  if (/(^|\/)jobs\//.test(raw.sourceRoot ?? '')) return 'job';
  return 'app';
}

/**
 * Discovers every runnable Nx application under apps/.
 * @param repoRoot - absolute path to the monorepo root
 * @returns the serveable projects, sorted by kind then name
 */
export async function discoverProjects(repoRoot) {
  const files = await findProjectFiles(join(repoRoot, 'apps'), 4);
  const projects = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (!raw.targets?.serve) continue;
    const tags = raw.tags ?? [];
    projects.push({
      name: raw.name,
      root: relative(repoRoot, join(file, '..')),
      sourceRoot: raw.sourceRoot ?? null,
      kind: classify(raw),
      scope: tags.find((tag) => tag.startsWith('scope:'))?.slice('scope:'.length) ?? null,
    });
  }
  const order = { app: 0, job: 1, frontend: 2 };
  return projects.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}
