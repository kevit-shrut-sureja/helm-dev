import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.nx', 'coverage']);
const LOG_METHODS = new Set(['log', 'error', 'warn', 'debug', 'verbose', 'trace', 'fatal', 'info']);
const MAX_CALL_CHARS = 4000;

/**
 * Recursively collects every non-spec TypeScript file under a directory.
 * @param dir - absolute directory to walk
 * @returns absolute paths of the TypeScript sources found
 */
async function collectSources(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...(await collectSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Turns a template literal body into a regular expression that matches its rendered output.
 * @param raw - the template literal source, without the enclosing backticks
 * @returns an anchored regex source string
 */
function templateToPattern(raw) {
  let out = '';
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === '$' && raw[index + 1] === '{') {
      let depth = 1;
      index += 2;
      while (index < raw.length && depth > 0) {
        if (raw[index] === '{') depth += 1;
        if (raw[index] === '}') depth -= 1;
        index += 1;
      }
      out += '[\\s\\S]*?';
      continue;
    }
    out += raw[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return `^${out}$`;
}

/**
 * Reads the identifier immediately preceding a position, used to confirm a call is on a logger.
 * @param text - the full file contents
 * @param end - index just past the identifier
 * @returns the identifier text
 */
function identifierBefore(text, end) {
  let start = end;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start -= 1;
  return text.slice(start, end);
}

/**
 * Extracts every top-level string and template literal from a call's argument list.
 * @param text - the full file contents
 * @param openParen - index of the call's opening parenthesis
 * @returns the literals found, each flagged as template or plain
 */
function readCallLiterals(text, openParen) {
  const literals = [];
  let argText = '';
  let depth = 0;
  let nested = 0;
  let index = openParen;
  const limit = Math.min(text.length, openParen + MAX_CALL_CHARS);

  while (index < limit) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) break;
    } else if (char === '{' || char === '[') nested += 1;
    else if (char === '}' || char === ']') nested -= 1;
    else if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let cursor = index + 1;
      let body = '';
      while (cursor < limit) {
        if (text[cursor] === '\\') {
          body += text[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote) break;
        body += text[cursor];
        cursor += 1;
      }
      if (nested === 0 && depth === 1 && body.length > 0) {
        literals.push({ body, isTemplate: quote === '`' });
      }
      index = cursor + 1;
      continue;
    }
    if (nested === 0 && depth === 1) argText += char;
    index += 1;
  }
  // Messages are often a constant (`ERRORS.BOT_NOT_AUTHENTICATED`) rather than a
  // literal; the constant's name is the only handle the call site offers.
  const identifiers = [...argText.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((match) => match[1]);
  return { literals, identifiers: [...new Set(identifiers)] };
}

/**
 * Maps each character offset in a file to its 1-based line number.
 * @param text - the full file contents
 * @returns the offsets at which each line starts
 */
function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/**
 * Binary-searches the line number containing an offset.
 * @param starts - line start offsets
 * @param offset - character offset
 * @returns the 1-based line number
 */
function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Scans one source file for logger call sites and the message literals they emit.
 * @param repoRoot - absolute path to the monorepo root
 * @param file - absolute path of the file to scan
 * @returns the call-site entries found in the file
 */
async function scanFile(repoRoot, file) {
  const text = await readFile(file, 'utf8');
  // Constants live in files of their own, with no logger call anywhere in them.
  const hasConstants = /[A-Z][A-Z0-9_]{3,}\s*[:=]\s*['"`]/.test(text);
  if (!text.includes('ogger') && !text.includes('console.') && !hasConstants) return [];

  const starts = lineStarts(text);
  const classes = [];
  const classRe = /\bclass\s+([A-Za-z0-9_$]+)/g;
  let classMatch = classRe.exec(text);
  while (classMatch !== null) {
    classes.push({ offset: classMatch.index, name: classMatch[1] });
    classMatch = classRe.exec(text);
  }

  const relPath = relative(repoRoot, file);
  const entries = [];

  const constRe = /(?:^|[\s{,])([A-Z][A-Z0-9_]{3,})\s*[:=]\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/gm;
  let constMatch = constRe.exec(text);
  while (constMatch !== null) {
    // Only sentence-like values can plausibly be a log message; short codes and
    // single tokens would bloat the index without ever matching one.
    if (constMatch[3].length < 8 || !constMatch[3].includes(' ')) {
      constMatch = constRe.exec(text);
      continue;
    }
    entries.push({
      f: relPath,
      l: lineAt(starts, constMatch.index),
      c: null,
      m: 'const',
      k: 'constant',
      s: null,
      r: null,
      i: constMatch[1],
      v: constMatch[3],
    });
    constMatch = constRe.exec(text);
  }
  const callRe = /\.([A-Za-z]+)\s*\(/g;
  let call = callRe.exec(text);

  while (call !== null) {
    const method = call[1];
    if (LOG_METHODS.has(method)) {
      const receiver = identifierBefore(text, call.index);
      // Legacy `platform` exposes its pino logger through a log4js-style `log`.
      const isLogger = /logger$/i.test(receiver) || receiver === 'log';
      const kind = isLogger ? 'logger' : receiver === 'console' ? 'console' : null;
      if (kind !== null) {
        const openParen = call.index + call[0].length - 1;
        const { literals, identifiers } = readCallLiterals(text, openParen);
        if (literals.length > 0 || identifiers.length > 0) {
          const line = lineAt(starts, call.index);
          let enclosing = null;
          for (const candidate of classes) {
            if (candidate.offset < call.index) enclosing = candidate.name;
            else break;
          }
          for (const identifier of identifiers) {
            entries.push({ f: relPath, l: line, c: enclosing, m: method, k: kind, s: null, r: null, i: identifier });
          }
          for (const literal of literals) {
            entries.push({
              f: relPath,
              l: line,
              c: enclosing,
              m: method,
              k: kind,
              s: literal.isTemplate ? null : literal.body,
              r: literal.isTemplate ? templateToPattern(literal.body) : null,
            });
          }
        }
      }
    }
    call = callRe.exec(text);
  }
  return entries;
}

/**
 * Builds the full logger call-site index across apps/ and libs/.
 * @param repoRoot - absolute path to the monorepo root
 * @returns the index payload, including build duration and file count
 */
export async function buildIndex(repoRoot) {
  const started = Date.now();
  let head = null;
  try {
    head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  } catch {
    // Not a git checkout, or git is unavailable; the cache simply loses that check.
  }
  const files = [...(await collectSources(join(repoRoot, 'apps'))), ...(await collectSources(join(repoRoot, 'libs')))];
  const entries = [];
  for (const file of files) {
    entries.push(...(await scanFile(repoRoot, file)));
  }
  return {
    builtAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    files: files.length,
    repoRoot,
    head,
    entries,
  };
}

/**
 * Wraps a raw index in the lookup structures used to resolve log messages.
 */
// A busy service repeats the same handful of messages constantly; a rate-limit
// warning or a recurring 3rd-party timeout gets clicked into more than once
// while chasing it down. Caching those saves real work. Messages carrying
// dynamic values (an order id, a request id) each mint a distinct cache key
// though, so the cache is capped rather than left to grow with the session —
// unbounded would be exactly the kind of footprint this tool exists to avoid.
const RESOLVE_CACHE_LIMIT = 2000;

export class LogSiteIndex {
  #exact = new Map();
  #patterns = [];
  #prefixes = [];
  #constantsByValue = new Map();
  #callsByIdentifier = new Map();
  // Insertion-ordered, so the oldest entry is always the FIFO eviction target —
  // the same pattern the log buffer itself uses.
  #resolveCache = new Map();

  constructor(payload) {
    this.meta = { builtAt: payload.builtAt, tookMs: payload.tookMs, files: payload.files, sites: payload.entries.length };
    for (const entry of payload.entries) {
      if (entry.k === 'constant') {
        const bucket = this.#constantsByValue.get(entry.v);
        if (bucket) bucket.push(entry);
        else this.#constantsByValue.set(entry.v, [entry]);
        continue;
      }
      if (entry.i !== undefined && entry.i !== null) {
        const bucket = this.#callsByIdentifier.get(entry.i);
        if (bucket) bucket.push(entry);
        else this.#callsByIdentifier.set(entry.i, [entry]);
        continue;
      }
      if (entry.s !== null) {
        const bucket = this.#exact.get(entry.s);
        if (bucket) bucket.push(entry);
        else this.#exact.set(entry.s, [entry]);
      } else if (entry.r !== null) {
        this.#patterns.push({ ...entry, re: new RegExp(entry.r) });
      }
      // `console.log('label', value)` prints the label followed by the value, so
      // the runtime line only starts with the indexed literal.
      if (entry.k === 'console' && entry.s !== null && entry.s.length >= 4) {
        this.#prefixes.push(entry);
      }
    }
  }

  /**
   * Resolves a runtime log message back to the source line that emitted it.
   * @param message - the rendered log message
   * @param context - the pino/Nest logger context, usually the emitting class name
   * @returns the best match, its confidence, and any other candidates
   */
  resolve(message, context, options = {}) {
    if (typeof message !== 'string' || message.length === 0) {
      return { match: null, confidence: 'none', candidates: [] };
    }
    const cacheKey = `${options.serviceRoot ?? ''}\u0000${context ?? ''}\u0000${message}`;
    const cached = this.#resolveCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = this.#resolveUncached(message, context, options);
    this.#resolveCache.set(cacheKey, result);
    if (this.#resolveCache.size > RESOLVE_CACHE_LIMIT) {
      this.#resolveCache.delete(this.#resolveCache.keys().next().value);
    }
    return result;
  }

  /**
   * The actual resolution — kept separate so {@link resolve} can memoize it
   * without a method that returns early from six different places.
   * @param message - the rendered log message
   * @param context - the pino/Nest logger context, usually the emitting class name
   * @param options - `serviceRoot` narrows matches to the emitting service
   * @returns the best match, its confidence, and any other candidates
   */
  #resolveUncached(message, context, options) {
    // A line printed by one service cannot come from another service's source —
    // those files are not even loaded in that process. Shared libs stay in scope.
    const root = options.serviceRoot;
    const inScope = (entry) => entry.f.startsWith(`${root}/`) || entry.f.startsWith('libs/');

    const exact = this.#exact.get(message) ?? [];
    const pick = (candidates, kind) => {
      const owned = root ? candidates.filter(inScope) : [];
      const reachable = owned.length > 0 ? owned : candidates;
      const scoped = context ? reachable.filter((entry) => entry.c === context) : [];
      const chosen = scoped.length > 0 ? scoped : reachable;
      if (chosen.length === 0) return null;
      return {
        match: {
          file: chosen[0].f,
          line: chosen[0].l,
          class: chosen[0].c,
          method: chosen[0].m,
          kind: chosen[0].k ?? 'logger',
        },
        confidence: chosen.length === 1 ? kind : 'ambiguous',
        candidates: chosen.slice(0, 10).map((entry) => ({ file: entry.f, line: entry.l, class: entry.c })),
      };
    };

    const exactPick = pick(exact, 'exact');
    if (exactPick) return exactPick;

    const matched = this.#patterns.filter((entry) => entry.re.test(message));
    const patternPick = pick(matched, 'pattern');
    if (patternPick) return patternPick;

    const trimmed = message.trim();
    const byPrefix = this.#prefixes.filter((entry) => trimmed.startsWith(entry.s));
    const prefixPick = pick(byPrefix, 'prefix');
    if (prefixPick) return prefixPick;

    // The message may be a constant. Prefer the call site that logs it; fall back
    // to where the text itself is defined.
    const constants = this.#constantsByValue.get(trimmed) ?? [];
    if (constants.length > 0) {
      const callers = constants.flatMap((constant) => this.#callsByIdentifier.get(constant.i) ?? []);
      const callerPick = pick(callers, 'constant');
      if (callerPick) return { ...callerPick, constant: constants[0].i };
      const definition = pick(constants, 'definition');
      if (definition) return { ...definition, constant: constants[0].i };
    }

    return { match: null, confidence: 'none', candidates: [] };
  }
}

/**
 * Loads the cached index, rebuilding it when the cache is missing or stale.
 * @param repoRoot - absolute path to the monorepo root
 * @param cachePath - absolute path of the cache file
 * @param force - true to rebuild regardless of the cache
 * @returns the ready-to-query index
 */
export async function loadIndex(repoRoot, cachePath, force) {
  if (!force) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      // A cache copied from another machine, or built on another commit, holds
      // line numbers that no longer point anywhere useful.
      const sameRepo = cached.repoRoot === repoRoot;
      let sameHead = true;
      if (cached.head) {
        try {
          sameHead = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim() === cached.head;
        } catch {
          sameHead = true;
        }
      }
      if (sameRepo && sameHead) return new LogSiteIndex(cached);
    } catch {
      // No usable cache; fall through to a fresh build.
    }
  }
  // Scanning ~6k files leaves a lot of short-lived garbage. Doing it in a child
  // process that then exits keeps the long-running server's footprint flat.
  const builder = join(dirname(fileURLToPath(import.meta.url)), 'build-index.mjs');
  await run(process.execPath, [builder, repoRoot, cachePath]);
  return new LogSiteIndex(JSON.parse(await readFile(cachePath, 'utf8')));
}
