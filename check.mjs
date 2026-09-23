#!/usr/bin/env node
// A standing check against the one failure this codebase actually has: an edit
// that replaces a block and silently drops something the rest still refers to.
// Every kind below has happened — four API routes, a page of CSS, and two
// functions still being called — and none of it surfaced until a button stopped
// working days later.
//
//   node check.mjs       exits non-zero when something is referred to but gone

import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Anything that reads as `name(` but is not a function this code owns.
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'function', 'else', 'do', 'of', 'in', 'case', 'void', 'delete', 'yield', 'async', 'get', 'set']);
const GLOBALS = new Set([
  'fetch', 'confirm', 'alert', 'prompt', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'Number', 'String', 'Boolean', 'Math', 'JSON', 'Date', 'Array', 'Object', 'Set', 'Map',
  'RegExp', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'EventSource', 'URL', 'URLSearchParams', 'localStorage',
  'console', 'document', 'window', 'navigator', 'translateY', 'rgba', 'url', 'all', 'file', 'line', 'not',
]);
const read = (file) => readFileSync(join(HERE, file), 'utf8');
const problems = [];

/**
 * Reports a broken reference.
 * @param area - the check that found it
 * @param message - what is missing and where it is used
 */
function fail(area, message) {
  problems.push(`${area}: ${message}`);
}

/**
 * Strips comments and string bodies, so a name inside prose or a message cannot
 * be mistaken for a reference to code.
 * @param source - the module source
 * @returns the source with comments and literal text blanked out
 */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const server = read('server.mjs');
const html = read('public/index.html');
const styles = readdirSync(join(HERE, 'public/styles')).filter((file) => file.endsWith('.css'));
const css = styles.map((file) => read(`public/styles/${file}`)).join('\n');
const modules = readdirSync(join(HERE, 'public')).filter((file) => file.endsWith('.js'));
const sources = new Map(modules.map((file) => [file, read(`public/${file}`)]));
const page = [...sources.values()].join('\n');

/* ---------- 1. every endpoint the page calls is served ---------- */

const served = new Set([...server.matchAll(/'(?:GET|POST) (\/api\/[\w/-]+)'/g)].map((m) => m[1]));
for (const match of server.matchAll(/url\.pathname === '(\/api\/[\w/-]+)'/g)) served.add(match[1]);

for (const match of page.matchAll(/['"`](\/api\/[\w/-]+)['"`]/g)) {
  if (!served.has(match[1])) fail('route', `the page calls ${match[1]}, the server does not serve it`);
}

/* ---------- 2. every class the page emits has a rule ---------- */

// Classes chosen at runtime from data — log levels, themes, confidence badges —
// are listed by hand because no static reading of the source can find them.
const DYNAMIC = new Set(['hit', 'on', 'selected', 'member', 'grow', 'muted', 'ln', 'path', 'svc', 'time', 'msg']);
// These carry behaviour, not appearance: they exist only as querySelector hooks,
// so having no rule is correct rather than a loss.
const HOOKS = new Set(['copy-btn', 'trace-btn', 'candidate-open', 'lvlFilter']);
const emitted = new Set();

for (const source of [page, html]) {
  for (const match of source.matchAll(/class="([^"${}]+)"/g)) {
    for (const name of match[1].trim().split(/\s+/)) emitted.add(name);
  }
  for (const match of source.matchAll(/classList\.(?:add|toggle|remove)\('([\w-]+)'/g)) emitted.add(match[1]);
  for (const match of source.matchAll(/className = '([\w -]+)'/g)) {
    for (const name of match[1].trim().split(/\s+/)) emitted.add(name);
  }
}

for (const name of [...emitted].sort()) {
  if (DYNAMIC.has(name) || HOOKS.has(name)) continue;
  if (!new RegExp(`\\.${name}\\b`).test(css)) fail('style', `class "${name}" is emitted but has no rule`);
}

/* ---------- 3. the page's modules agree with each other ---------- */

// What each module declares at its top level, and what it says it exports.
const declared = new Map();
const exported = new Map();
for (const [file, source] of sources) {
  const body = code(source);
  declared.set(file, new Set([...body.matchAll(/\b(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1])));
  exported.set(file, new Set([...body.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map((m) => m[1])));
}

for (const [file, source] of sources) {
  const body = code(source);
  const imported = new Map();
  for (const match of source.matchAll(/import\s*{([^}]+)}\s*from\s*'\.\/([\w.-]+)'/g)) {
    for (const name of match[1].split(',').map((part) => part.trim()).filter(Boolean)) {
      imported.set(name, match[2]);
      if (!exported.get(match[2])?.has(name)) fail('module', `${file} imports ${name} from ${match[2]}, which does not export it`);
    }
  }

  // Anything this module calls must be its own, imported, or a browser global.
  for (const match of body.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/gi)) {
    const name = match[1];
    if (KEYWORDS.has(name) || GLOBALS.has(name)) continue;
    if (declared.get(file).has(name) || imported.has(name)) continue;
    const owner = [...exported].find(([, names]) => names.has(name))?.[0];
    if (owner) fail('module', `${file} calls ${name}() from ${owner} without importing it`);
    else fail('module', `${file} calls ${name}(), which is declared nowhere`);
  }
}

/* ---------- 4. every module is actually reachable ---------- */

// A module nobody imports is dead code that looks alive. `layout.js` sat unloaded
// for a day this way: it exports nothing, so no reference to it was missing.
const ENTRY = 'app.js';
const importedFiles = new Set(
  [...page.matchAll(/from\s*'\.\/([\w.-]+)'/g)].map((m) => m[1]).concat(
    [...page.matchAll(/^import\s*'\.\/([\w.-]+)';/gm)].map((m) => m[1]),
  ),
);
for (const file of modules) {
  if (file !== ENTRY && !importedFiles.has(file)) fail('module', `${file} is imported by nothing — it never loads`);
}

/* ---------- 4. every element the page asks for exists ---------- */

// Ids come from the HTML or from markup the page builds itself, so both count.
const ids = new Set([...`${html}\n${page}`.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
for (const match of page.matchAll(/\.id = '([\w-]+)'/g)) ids.add(match[1]);

for (const [file, source] of sources) {
  for (const match of source.matchAll(/getElementById\('([\w-]+)'\)/g)) {
    if (!ids.has(match[1])) fail('element', `${file} asks for #${match[1]}, which nothing creates`);
  }
}

/* ---------- 4. everything still parses ---------- */

const scripts = [
  'server.mjs',
  'check.mjs',
  ...modules.map((file) => `public/${file}`),
  ...readdirSync(join(HERE, 'lib')).map((file) => `lib/${file}`),
];
for (const script of scripts.filter((file) => file.endsWith('.mjs') || file.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', join(HERE, script)], { stdio: 'pipe' });
  } catch (error) {
    fail('syntax', `${script}: ${String(error.stderr).split('\n')[0]}`);
  }
}

if (problems.length === 0) {
  process.stdout.write(
    `ok — ${served.size} routes, ${emitted.size} classes in ${styles.length} stylesheets, ` +
      `${ids.size} element ids, ${modules.length} page modules, ${scripts.length} scripts\n`,
  );
  process.exit(0);
}
for (const problem of problems) process.stderr.write(`${problem}\n`);
process.stderr.write(`\n${problems.length} problem(s)\n`);
process.exit(1);
