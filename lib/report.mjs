import { execFile, spawn } from 'node:child_process';
import { arch, homedir, platform, release } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Images live on their own branch so they never touch anyone's history of real
// work. `gh issue create` has no way to attach a file, so this is where they go.
const ASSET_BRANCH = 'report-assets';
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const GH_TIMEOUT_MS = 60000;

export const CATEGORIES = [
  'A service would not start or stop',
  'A service showed the wrong status',
  'A log line pointed at the wrong source',
  'Logs were missing or in the wrong place',
  'Filters or search misbehaved',
  'It was slow or used too much memory',
  'Adding or reading a repository',
  'Layout or appearance',
  'Something else',
];

/**
 * Runs `gh`, optionally feeding it a body on stdin. Arguments are passed as an
 * array and never through a shell, so nothing a user typed can become a command.
 * @param args - the gh arguments
 * @param input - text written to stdin, or null
 * @param cwd - directory to run in, so gh resolves the right repository
 * @returns the trimmed stdout
 */
function gh(args, input = null, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: GH_TIMEOUT_MS });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => {
      reject(new Error(error.code === 'ENOENT' ? 'The GitHub CLI (gh) is not installed.' : error.message));
    });
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `gh exited with code ${code}`));
    });
    // A write to a process that already died would otherwise be an unhandled error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/**
 * Works out where reports go and whether this machine can send them, so the form
 * can say so before anyone has typed anything.
 * @param appRoot - the helm-dev folder, whose git remote names the repository
 * @returns the repository, its visibility and default branch, or the reason it is unavailable
 */
export async function reportTarget(appRoot) {
  try {
    await gh(['auth', 'status']);
  } catch (error) {
    const missing = /not installed/.test(error.message);
    return { ready: false, reason: missing ? error.message : 'GitHub CLI is not logged in. Run `gh auth login` in a terminal.' };
  }
  try {
    const forced = process.env.HELMDEV_REPORT_REPO;
    const args = ['repo', 'view', ...(forced ? [forced] : []), '--json', 'nameWithOwner,visibility,defaultBranchRef'];
    const info = JSON.parse(await gh(args, null, appRoot));
    return {
      ready: true,
      repo: info.nameWithOwner,
      visibility: String(info.visibility).toLowerCase(),
      defaultBranch: info.defaultBranchRef?.name ?? 'main',
    };
  } catch (error) {
    return { ready: false, reason: `Could not find the helm-dev repository from its git remote: ${error.message}` };
  }
}

/**
 * Reads the commit helm-dev itself is running from, which a version number alone
 * cannot say once someone is on a branch.
 * @param appRoot - the helm-dev folder
 * @returns the short commit, with a marker when the tree has local edits
 */
async function appCommit(appRoot) {
  try {
    const [commit, dirty] = await Promise.all([
      run('git', ['rev-parse', '--short', 'HEAD'], { cwd: appRoot }),
      run('git', ['status', '--porcelain'], { cwd: appRoot }),
    ]);
    return `${commit.stdout.trim()}${dirty.stdout.trim().length > 0 ? '+local edits' : ''}`;
  } catch {
    // Not a git checkout; the version alone will have to do.
    return 'unknown';
  }
}

/**
 * Keeps a table cell from breaking the table or running on.
 * @param value - any value
 * @param limit - the longest text to keep
 * @returns a single-line, pipe-free string
 */
function cell(value, limit = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Formats how long a service has been up.
 * @param startedAt - epoch milliseconds, or null
 * @returns a short duration, or an empty string
 */
function uptime(startedAt) {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Describes the page's current filters without sending what was typed into them —
 * a search box can hold anything.
 * @param view - the filter state the page reports
 * @returns one line saying what the log pane was showing
 */
function describeView(view = {}) {
  const parts = [];
  parts.push(view.showNoise ? 'noise shown' : 'noise hidden');
  if (view.hiddenLevels?.length > 0) parts.push(`levels off: ${view.hiddenLevels.join(', ')}`);
  parts.push(view.focusCount > 0 ? `focused on ${view.focusCount} service(s)` : 'all services');
  if (view.trace) parts.push(`tracing a ${cell(view.trace, 30)}`);
  if (view.hasSearch) parts.push('a text filter was set');
  if (view.cleared) parts.push('screen had been cleared');
  return parts.join(' · ');
}

/**
 * Gathers everything about the running session that a maintainer would otherwise
 * have to ask for. None of it is typed by the reporter, and none of it is log text.
 * @param context - the live state: version, workspaces, stats, settings and the page's view
 * @param appRoot - the helm-dev folder
 * @returns a markdown block
 */
export async function buildMetadata(context, appRoot) {
  const { version, workspaces, stats, settings, view, category } = context;
  const lines = [];

  lines.push('| | |', '|---|---|');
  lines.push(`| **Category** | ${cell(category)} |`);
  lines.push(`| helm-dev | v${version} (${await appCommit(appRoot)}) |`);
  lines.push(`| Node | ${process.version} |`);
  lines.push(`| System | ${platform()} ${release()} ${arch()} |`);
  const memory = [];
  if (stats?.availableMB) memory.push(`${(stats.availableMB / 1000).toFixed(1)}GB free`);
  if (stats?.selfMB) memory.push(`helm-dev ${stats.selfMB}MB`);
  if (stats?.bufferMB !== undefined) memory.push(`log buffer ${stats.bufferMB}/${stats.bufferMaxMB}MB (${stats.buffered} lines)`);
  if (memory.length > 0) lines.push(`| Memory | ${memory.join(' · ')} |`);
  lines.push(
    `| Settings | ${settings?.resolvedConcurrency} start(s) at a time · buffer ${settings?.bufferMB}MB · frontends ${
      settings?.muteFrontends ? 'muted' : 'not muted'
    } |`,
  );
  lines.push(`| Log pane | ${describeView(view)} |`);

  lines.push('', '**Workspaces**', '', '| name | branch | local changes | projects | log sites indexed |', '|---|---|---|---|---|');
  for (const workspace of workspaces) {
    const git = stats?.git?.[workspace.name];
    lines.push(
      `| ${cell(workspace.name)} | ${cell(git?.branch ?? 'unknown')} | ${
        git ? `${git.modified} modified, ${git.untracked} untracked` : ''
      } | ${workspace.projects.length} | ${workspace.index?.meta?.sites ?? 0} |`,
    );
  }

  const rows = [];
  let idle = 0;
  for (const workspace of workspaces) {
    const statuses = workspace.runner.statuses();
    for (const project of workspace.projects) {
      const entry = statuses[project.name];
      const queued = workspace.runner.queued().includes(project.name);
      const external = workspace.external[project.name];
      if (!entry && !queued && !external) {
        idle += 1;
        continue;
      }
      if (entry?.status === 'stopped' && !queued && !external) {
        idle += 1;
        continue;
      }
      const status = queued ? 'queued' : external ? 'started outside helm-dev' : entry.status;
      const ports = entry?.ports?.length > 0 ? entry.ports.map((port) => `:${port}`).join(' ') : '';
      const notes = [];
      if (entry?.confirmed === false) notes.push('not confirmed by a listening port');
      if (entry?.mode === 'live') notes.push('live reload');
      if (workspace.runner.muted().includes(project.name)) notes.push('logs muted');
      if (entry?.reason) notes.push(`reason: ${entry.reason}`);
      if (entry?.exitCode !== null && entry?.exitCode !== undefined && entry.status === 'failed') notes.push(`exit ${entry.exitCode}`);
      rows.push(
        `| ${cell(workspace.name)}/${cell(project.name)} | ${project.kind} | ${status} | ${ports} | ${uptime(entry?.startedAt)} | ${cell(
          notes.join('; '),
        )} |`,
      );
    }
  }
  lines.push('', '**Services**', '');
  if (rows.length === 0) {
    lines.push('Nothing was running or queued.');
  } else {
    lines.push('| service | kind | status | ports | up | notes |', '|---|---|---|---|---|---|', ...rows);
    lines.push('', `${idle} other service(s) were stopped.`);
  }
  return lines.join('\n').replaceAll(homedir(), '~');
}

/**
 * Puts the reporter's words and the gathered facts into one issue body.
 * @param description - what the reporter wrote
 * @param metadata - the block from {@link buildMetadata}
 * @param imageLinks - markdown image lines for screenshots that were uploaded
 * @returns the markdown body, with the user's home directory shortened to ~
 */
export function buildBody(description, metadata, imageLinks = []) {
  const parts = [description.trim() || '_No description given._'];
  if (imageLinks.length > 0) parts.push(imageLinks.join('\n\n'));
  parts.push(`<details open>\n<summary>Added automatically by helm-dev</summary>\n\n${metadata}\n\n</details>`);
  // A reason or path can carry the username; nothing here needs it.
  return parts.join('\n\n---\n\n').replaceAll(homedir(), '~');
}

/**
 * Checks what the page sent before any of it goes near GitHub.
 * @param form - title, description, category and images from the page
 * @returns the problem in words, or null when the form is acceptable
 */
export function validateReport(form) {
  if (typeof form.title !== 'string' || form.title.trim().length === 0) return 'Add a title.';
  if (form.title.length > 200) return 'The title is too long (200 characters at most).';
  if (typeof form.description !== 'string' || form.description.length > 20000) return 'The description is missing or too long.';
  if (!CATEGORIES.includes(form.category)) return 'Pick what went wrong.';
  const images = form.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return `Attach at most ${MAX_IMAGES} screenshots.`;
  for (const image of images) {
    if (!IMAGE_TYPES[image?.type]) return 'Screenshots must be PNG, JPEG, GIF or WebP.';
    if (typeof image.data !== 'string' || Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) {
      return `Each screenshot must be under ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`;
    }
  }
  return null;
}

/**
 * Commits the screenshots to the assets branch, creating it from the default
 * branch the first time.
 * @param target - the repository, from {@link reportTarget}
 * @param images - the validated images
 * @returns markdown image lines, one per screenshot
 */
async function uploadImages(target, images) {
  try {
    await gh(['api', `repos/${target.repo}/git/ref/heads/${ASSET_BRANCH}`]);
  } catch {
    const sha = await gh(['api', `repos/${target.repo}/git/ref/heads/${target.defaultBranch}`, '--jq', '.object.sha']);
    await gh(['api', '-X', 'POST', `repos/${target.repo}/git/refs`, '-f', `ref=refs/heads/${ASSET_BRANCH}`, '-f', `sha=${sha}`]);
  }
  const folder = `reports/${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
  const links = [];
  for (const [index, image] of images.entries()) {
    const path = `${folder}/${index + 1}.${IMAGE_TYPES[image.type]}`;
    // The image is far over the length of a command-line argument, so the whole
    // request goes in on stdin.
    const body = JSON.stringify({ message: `Screenshot for a helm-dev report`, content: image.data, branch: ASSET_BRANCH });
    await gh(['api', '-X', 'PUT', `repos/${target.repo}/contents/${path}`, '--input', '-'], body);
    links.push(`![screenshot ${index + 1}](https://github.com/${target.repo}/raw/${ASSET_BRANCH}/${path})`);
  }
  return links;
}

/**
 * Files the issue. A screenshot that cannot be uploaded (no push access, say)
 * costs the screenshot, never the report.
 * @param form - the validated title, description, category and images
 * @param metadata - the block from {@link buildMetadata}
 * @param target - the repository, from {@link reportTarget}
 * @returns the issue URL and any warnings
 */
export async function submitReport(form, metadata, target) {
  const warnings = [];
  let links = [];
  const images = form.images ?? [];
  if (images.length > 0) {
    try {
      links = await uploadImages(target, images);
    } catch (error) {
      warnings.push(`The screenshots could not be uploaded (${error.message.split('\n')[0]}). Drag them into the issue yourself.`);
    }
  }
  const body = buildBody(form.description, metadata, links);
  const out = await gh(['issue', 'create', '-R', target.repo, '--title', form.title.trim(), '--body-file', '-'], body);
  return { url: out.split('\n').pop(), warnings };
}
