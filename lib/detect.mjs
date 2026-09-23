import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SERVE_RE = /\bnx\s+(?:serve|run)\s+([A-Za-z0-9._-]+)(?::serve)?/;

/**
 * Resolves a process's working directory, used to tell repositories apart.
 * @param pid - the process id
 * @returns the absolute cwd, or null when it cannot be read
 */
async function processCwd(pid) {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Finds `nx serve` processes belonging to this repo that devscope did not start.
 * Several Nx workspaces can run side by side, so each candidate is confirmed by its cwd.
 * @param repoRoot - absolute path to the monorepo root
 * @param knownNames - project names devscope knows about
 * @returns a map of project name to the external process running it
 */
export async function detectExternal(repoRoot, knownNames) {
  let stdout = '';
  try {
    ({ stdout } = await run('ps', ['-eo', 'pid=,args=']));
  } catch {
    return {};
  }

  const byName = new Map();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const spaceAt = trimmed.indexOf(' ');
    const pid = Number(trimmed.slice(0, spaceAt));
    const args = trimmed.slice(spaceAt + 1);
    if (!Number.isFinite(pid)) continue;

    const match = SERVE_RE.exec(args);
    if (match === null || !knownNames.has(match[1])) continue;
    const bucket = byName.get(match[1]) ?? [];
    bucket.push({ pid, args });
    byName.set(match[1], bucket);
  }

  const detected = {};
  for (const [name, candidates] of byName) {
    for (const candidate of candidates) {
      const cwd = await processCwd(candidate.pid);
      if (cwd !== null && (cwd === repoRoot || cwd.startsWith(`${repoRoot}/`))) {
        detected[name] = { pid: candidate.pid, cwd, args: candidate.args };
        break;
      }
    }
  }
  return detected;
}

/**
 * Sends SIGTERM to the process group of an externally started service.
 * @param pid - a pid belonging to that service
 * @returns true when a signal was delivered
 */
export async function killExternal(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const groupId = Number(afterComm[2]);
    process.kill(Number.isFinite(groupId) && groupId > 0 ? -groupId : pid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}
