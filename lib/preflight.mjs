import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
 * Snapshots every TCP socket that is listening, with the process holding it.
 * One call answers both "is this port taken" and "which service owns it".
 * @returns {port, pid, command} for each listener, empty when `ss` is unavailable
 */
export async function listeners() {
  try {
    const { stdout } = await run('ss', ['-lptnH']);
    const found = [];
    for (const line of stdout.split('\n')) {
      const port = /:(\d+)\s/.exec(line)?.[1];
      if (!port) continue;
      const owners = [...line.matchAll(/\("([^"]+)",pid=(\d+)/g)];
      if (owners.length === 0) found.push({ port: Number(port), pid: null, command: 'another process' });
      for (const owner of owners) found.push({ port: Number(port), pid: Number(owner[2]), command: owner[1] });
    }
    return found;
  } catch {
    // No `ss` (not Linux) or no permission: nothing can be confirmed or warned about.
    return [];
  }
}

/**
 * Reports which of the given ports are already listening, and what holds them.
 * @param ports - the ports to check
 * @returns a map of port to the command holding it
 */
export async function portsInUse(ports) {
  if (ports.length === 0) return {};
  const held = {};
  for (const listener of await listeners()) {
    if (ports.includes(listener.port)) held[listener.port] = { command: listener.command, pid: listener.pid };
  }
  return held;
}

/**
 * Checks whether starting a service is likely to hurt, before it is started.
 * Both failures it looks for are ones a developer only notices once the machine
 * is already struggling.
 * @param project - the project about to start
 * @param booting - how many services are already mid-start
 * @param knownPorts - ports this service was seen listening on in an earlier run;
 *   empty on a first start, where a clash shows up as EADDRINUSE instead
 * @returns warnings worth confirming, empty when the start looks safe
 */
export async function preflight(project, booting, knownPorts = []) {
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

  const held = await portsInUse(knownPorts);
  for (const port of knownPorts) {
    if (!held[port]) continue;
    warnings.push({
      kind: 'port',
      message: `Port ${port} is already held by "${held[port].command}". ${project.name} will fail to bind.`,
    });
  }

  return warnings;
}
