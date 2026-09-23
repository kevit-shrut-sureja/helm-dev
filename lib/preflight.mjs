import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// A cold Nx build plus the service itself. Angular is the expensive one; these
// are deliberately conservative, since the cost of a wrong guess is a machine
// that swaps for ten minutes.
const EXPECTED_MB = { frontend: 2500, app: 900, job: 700 };
const HEADROOM_MB = 1200;

/**
 * Reads the memory the kernel believes is actually available, which accounts for
 * reclaimable cache and is far more useful than "free".
 * @returns available megabytes, or null when it cannot be determined
 */
export async function availableMemoryMB() {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const match = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
    return match === null ? null : Math.round(Number(match[1]) / 1024);
  } catch {
    return null;
  }
}

/**
 * Finds the port a project serves on, from its serve target or its env example.
 * @param repoRoot - absolute path to the workspace
 * @param project - the project record
 * @returns the port, or null when it declares none
 */
export async function portOf(repoRoot, project) {
  try {
    const raw = JSON.parse(await readFile(join(repoRoot, project.root, 'project.json'), 'utf8'));
    const declared = raw.targets?.serve?.options?.port;
    if (typeof declared === 'number') return declared;
  } catch {
    // Fall through to the env file.
  }
  try {
    const env = await readFile(join(repoRoot, project.root, '.env.example'), 'utf8');
    const match = /^PORT\s*=\s*"?(\d{2,5})"?/m.exec(env);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/**
 * Reports which of the given ports are already listening, and what holds them.
 * @param ports - the ports to check
 * @returns a map of port to the command holding it
 */
export async function portsInUse(ports) {
  if (ports.length === 0) return {};
  try {
    const { stdout } = await run('ss', ['-lptnH']);
    const held = {};
    for (const line of stdout.split('\n')) {
      const port = /:(\d+)\s/.exec(line)?.[1];
      if (port && ports.includes(Number(port))) {
        const owner = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
        held[Number(port)] = { command: owner?.[1] ?? 'another process', pid: owner ? Number(owner[2]) : null };
      }
    }
    return held;
  } catch {
    return {};
  }
}

/**
 * Checks whether starting a service is likely to hurt, before it is started.
 * Both failures it looks for are ones a developer only notices once the machine
 * is already struggling.
 * @param repoRoot - absolute path to the workspace
 * @param project - the project about to start
 * @param booting - how many services are already mid-start
 * @returns warnings worth confirming, empty when the start looks safe
 */
export async function preflight(repoRoot, project, booting) {
  const warnings = [];

  const expected = EXPECTED_MB[project.kind] ?? EXPECTED_MB.app;
  const available = await availableMemoryMB();
  if (available !== null && available < expected + HEADROOM_MB) {
    warnings.push({
      kind: 'memory',
      message:
        `${project.name} usually needs about ${(expected / 1000).toFixed(1)}GB while it builds, ` +
        `and only ${(available / 1000).toFixed(1)}GB is available` +
        `${booting > 0 ? ` with ${booting} other service(s) still starting` : ''}. ` +
        'Starting it now is likely to make the machine swap.',
    });
  }

  const port = await portOf(repoRoot, project);
  if (port !== null) {
    const held = await portsInUse([port]);
    if (held[port]) {
      warnings.push({
        kind: 'port',
        message: `Port ${port} is already held by "${held[port].command}". ${project.name} will fail to bind.`,
      });
    }
  }

  return warnings;
}
