// Claude Code PreToolUse hook. Before a `git commit` that changes how helm-dev
// behaves but touches none of its docs, it reminds the model that FEATURES.md and
// CLAUDE.md exist to be kept current. It never blocks: some commits (a refactor, a
// test fix) rightly change no docs, and the model is better placed to judge that
// than a file list is. Every failure is silent: a reminder is not worth breaking
// a commit over.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BEHAVIOUR = /^(server\.mjs|cli\.mjs|helm-dev|helmctl|lib\/|public\/|skills\/)/;
const DOCS = /^(FEATURES|CLAUDE)\.md$/;

/**
 * Lists the files a git command reports, one per line.
 * @param cwd - where to run git
 * @param args - the git arguments
 * @returns the paths, relative to the repository root
 */
function gitFiles(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input.tool_input?.command ?? '';
  if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0);

  const cwd = /\bgit\s+-C\s+(\S+)/.exec(command)?.[1] ?? input.cwd ?? process.cwd();
  const root = gitFiles(cwd, ['rev-parse', '--show-toplevel'])[0];
  if (!root) process.exit(0);

  // A commit is often staged in the same command (`git add … && git commit`, or
  // `commit -a`), and the hook runs before any of it. Counting every change in the
  // tree then over-reports a little, which for a reminder is the right way to err.
  const staged = gitFiles(root, ['diff', '--cached', '--name-only']);
  const stagesToo = /\bgit\s+add\b/.test(command) || /\bcommit\b[^|;&]*\s-[a-zA-Z]*a/.test(command);
  const files = stagesToo ? [...staged, ...gitFiles(root, ['diff', '--name-only', 'HEAD'])] : staged;

  const behaviour = files.filter((file) => BEHAVIOUR.test(file));
  if (behaviour.length === 0 || files.some((file) => DOCS.test(file))) process.exit(0);

  const shown = behaviour.slice(0, 6).join(', ') + (behaviour.length > 6 ? ', …' : '');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `helm-dev docs check: this commit changes ${shown} but no documentation. ` +
          'If it adds a feature or changes how one behaves (when it applies, when it does not, why), ' +
          'update its entry in FEATURES.md. If it makes a decision that would look wrong to the next reader, ' +
          "add it to CLAUDE.md's \"Things that look wrong but are deliberate\". " +
          'If neither applies (a refactor, a test, a pure bug fix), go ahead, and say why in the commit or PR.',
      },
    }),
  );
} catch {
  // Unreadable input or no git: say nothing and let the commit proceed.
}
