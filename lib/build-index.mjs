import { writeFile } from 'node:fs/promises';
import { buildIndex } from './log-index.mjs';

const [repoRoot, cachePath] = process.argv.slice(2);
const payload = await buildIndex(repoRoot);
await writeFile(cachePath, JSON.stringify(payload));
process.stdout.write(`${payload.entries.length}\n`);
