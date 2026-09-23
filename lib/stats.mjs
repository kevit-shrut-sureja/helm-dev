import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Sums the resident memory of a process and everything it spawned, because an
 * `nx serve` is a wrapper chain and the real application sits at the bottom.
 * @param roots - a map of service name to its root pid
 * @returns a map of service name to resident megabytes
 */
export async function serviceMemory(roots) {
  const names = Object.keys(roots);
  if (names.length === 0) return {};

  let stdout = '';
  try {
    ({ stdout } = await run('ps', ['-eo', 'pid=,ppid=,rss=']));
  } catch {
    return {};
  }

  const children = new Map();
  const rss = new Map();
  for (const line of stdout.split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid)) continue;
    rss.set(pid, kb);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }

  const totals = {};
  for (const name of names) {
    const stack = [roots[name]];
    const seen = new Set();
    let sum = 0;
    while (stack.length > 0) {
      const pid = stack.pop();
      if (seen.has(pid) || !rss.has(pid)) continue;
      seen.add(pid);
      sum += rss.get(pid);
      stack.push(...(children.get(pid) ?? []));
    }
    if (sum > 0) totals[name] = Math.round(sum / 1024);
  }
  return totals;
}

/**
 * Reads the repository's current branch and working-tree counts.
 * @param repoRoot - absolute path to the monorepo root
 * @returns the branch name and change counts, or null when git is unavailable
 */
export async function gitStatus(repoRoot) {
  try {
    const [branch, porcelain] = await Promise.all([
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }),
      run('git', ['status', '--porcelain'], { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    const lines = porcelain.stdout.split('\n').filter((line) => line.trim().length > 0);
    return {
      branch: branch.stdout.trim(),
      modified: lines.filter((line) => !line.startsWith('??')).length,
      untracked: lines.filter((line) => line.startsWith('??')).length,
    };
  } catch {
    return null;
  }
}
