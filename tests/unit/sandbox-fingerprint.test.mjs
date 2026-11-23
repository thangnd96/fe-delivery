// v0.4.3: one working tree, one fingerprint, whether it is computed inside Claude Code's
// sandbox (fe commands the agent runs) or outside it (fe's hooks and background refresh).
// The sandbox denies reading .env, .env.*, *.pem and *.key. There git cannot lstat those
// files, so `git diff HEAD` lists them as deleted while `git status` skips them, and a clean
// portal checkout read as stale inside the sandbox.
// Two ways to hide files from git here:
//   - chmod 000 on a folder: EACCES, and the folder cannot be listed (a deny rule on a whole
//     folder). Runs everywhere except as root.
//   - sandbox-exec with a Seatbelt profile (macOS): EPERM, names stay visible, the mechanism
//     Claude Code's sandbox uses there.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SECRET_GLOBS, worktreeStamp } from '../../scripts/lib/freshness.mjs';
import { failureLine } from '../../scripts/lib/pilothify.mjs';
import { FE, PLUGIN_ROOT, denied, fe, hook, sandbox, setProfile, startRun, write } from '../helpers.mjs';

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;

const git = (sb, ...a) => execFileSync('git', a, { cwd: sb.repo, encoding: 'utf8' });
const commitAll = (sb) => {
  git(sb, 'add', '-A');
  git(sb, 'commit', '-qm', 'more files');
};
const graphStatus = (sb, env = {}) => JSON.parse(fe({ ...sb, env: { ...sb.env, ...env } }, ['graph', 'status', '--json']).out);
const sessionContext = (sb) => hook(sb, 'session-start', {})?.hookSpecificOutput?.additionalContext || '';
const review = (sb) => hook(sb, 'pre-tool-use', { tool_name: 'Agent', tool_input: { subagent_type: 'fe-delivery:fe-reviewer', prompt: 'review' } });
const blockProfile = (sb) => setProfile(sb, (p) => { p.graph = { enforce: 'block' }; });

// Hides `dirs` with chmod 000, runs fn, then restores them. Returns false (and runs nothing)
// where the permissions do not bite.
function insideSandbox(sb, dirs, probe, fn) {
  for (const d of dirs) chmodSync(join(sb.repo, d), 0o000);
  try {
    try {
      lstatSync(join(sb.repo, probe));
      return false;
    } catch (e) {
      if (e.code !== 'EACCES' && e.code !== 'EPERM') return false;
    }
    fn();
    return true;
  } finally {
    for (const d of dirs) chmodSync(join(sb.repo, d), 0o755);
  }
}

// ---------- Seatbelt (macOS) ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function seatbelt(sb, extraRegexes = []) {
  const root = escapeRe(sb.repo);
  const rules = [`^${root}/(.*/)?\\.env(\\.[^/]*)?$`, `^${root}/.*\\.pem$`, `^${root}/.*\\.key$`, ...extraRegexes.map((r) => `^${root}/${r}`)];
  return `(version 1)(allow default)(deny file-read* ${rules.map((r) => `(regex #"${r}")`).join(' ')})`;
}
const inSeatbelt = (sb, profile, cmd, args) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, cmd, ...args], { cwd: sb.repo, env: sb.env, encoding: 'utf8' });
const feSeatbelt = (sb, profile, args) => {
  const res = inSeatbelt(sb, profile, process.execPath, [FE, ...args]);
  return { code: res.status, out: res.stdout, err: res.stderr };
};
const seatbeltWorks = (sb, profile, deleted) => process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
  && new RegExp(`^D\\t${escapeRe(deleted)}$`, 'm').test(inSeatbelt(sb, profile, 'git', ['diff', 'HEAD', '--name-status']).stdout || '');

test('the files the sandbox may not read never move the fingerprint: edited, added or hidden', (t) => {
  const sb = sandbox();
  write(sb, '.env.dev', 'API=1\n');
  write(sb, '.env.example', 'API=\n');
  write(sb, 'config/.env.stg', 'API=2\n');
  write(sb, 'certs/server.pem', 'PEM\n');
  write(sb, 'deploy/app.key', 'KEY\n');
  commitAll(sb);
  const clean = worktreeStamp(sb.repo);

  write(sb, '.env.dev', 'API=changed\n');
  write(sb, 'certs/server.pem', 'PEM, rotated\n');
  write(sb, '.env.local', 'LOCAL=1\n');
  write(sb, 'src/features/.env', 'NESTED=1\n');
  const edited = worktreeStamp(sb.repo);
  assert.equal(edited.fingerprint, clean.fingerprint, 'edits to secret files do not change the graph');
  assert.equal(edited.dirty_paths, 0);

  const ran = insideSandbox(sb, ['config', 'certs', 'deploy'], 'config/.env.stg', () => {
    assert.match(git(sb, 'diff', 'HEAD', '--name-status'), /^D\tconfig\/\.env\.stg$/m, 'git sees the hidden file as deleted, as in the sandbox');
    assert.equal(worktreeStamp(sb.repo).fingerprint, clean.fingerprint);
  });
  if (!ran) t.diagnostic('directory permissions do not apply to this user; the hidden case was not exercised');

  write(sb, 'src/features/profile/Badge.tsx', 'export const Badge = () => null;\n');
  assert.notEqual(worktreeStamp(sb.repo).fingerprint, clean.fingerprint, 'code still counts');
});

test('a tracked file in a folder hidden by any other deny rule counts as unchanged, not as deleted', (t) => {
  const sb = sandbox();
  write(sb, 'vault/token.txt', 'not a secret pattern\n');
  commitAll(sb);
  const clean = worktreeStamp(sb.repo);
  const ran = insideSandbox(sb, ['vault'], 'vault/token.txt', () => {
    assert.match(git(sb, 'diff', 'HEAD', '--name-status'), /^D\tvault\/token\.txt$/m);
    const inside = worktreeStamp(sb.repo);
    assert.equal(inside.fingerprint, clean.fingerprint);
    assert.deepEqual(inside.unreadable, ['vault'], 'the unlistable folder is the unit');
  });
  if (!ran) return t.skip('directory permissions do not apply to this user');
  assert.deepEqual(clean.unreadable, []);
  rmSync(join(sb.repo, 'vault/token.txt'));
  assert.notEqual(worktreeStamp(sb.repo).fingerprint, clean.fingerprint, 'a real deletion still counts');
});

test('a stamp written on one side of the sandbox is fresh on the other (graph status, session start)', (t) => {
  const sb = sandbox();
  write(sb, 'config/.env.stg', 'API=2\n');
  write(sb, 'vault/token.txt', 'x\n');
  commitAll(sb);
  const hiddenDirs = ['config', 'vault'];

  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  let ran = insideSandbox(sb, hiddenDirs, 'vault/token.txt', () => {
    const s = graphStatus(sb);
    assert.equal(s.fresh, true, `stamped outside, checked inside: ${s.reason}`);
    assert.deepEqual(s.unreadable_paths, ['vault']);
  });
  if (!ran) return t.skip('directory permissions do not apply to this user');

  ran = insideSandbox(sb, hiddenDirs, 'vault/token.txt', () => {
    const res = fe(sb, ['graph', 'ensure']);
    assert.equal(res.code, 0, res.err);
  });
  assert.ok(ran);
  const s = graphStatus(sb);
  assert.equal(s.fresh, true, `stamped inside, checked outside: ${s.reason}`);
  assert.doesNotMatch(sessionContext(sb), /may not match the code/);
});

test('an untracked file in a folder another deny rule hides: G10 lets the reviewer through after a refresh inside', (t) => {
  const sb = sandbox();
  write(sb, 'vault/token.txt', 'x\n');
  commitAll(sb);
  write(sb, 'vault/new-local.txt', 'not committed, not ignored\n');
  blockProfile(sb);
  startRun(sb);
  const ran = insideSandbox(sb, ['vault'], 'vault/token.txt', () => {
    const res = fe(sb, ['graph', 'ensure']);
    assert.equal(res.code, 0, res.err);
  });
  if (!ran) return t.skip('directory permissions do not apply to this user');
  assert.equal(graphStatus(sb).fresh, true, 'outside leaves out the folder the stamp could not read');
  assert.equal(review(sb), null, 'G10 does not block');
  write(sb, 'src/features/profile/Badge.tsx', 'export const Badge = () => null;\n');
  assert.ok(denied(review(sb)), 'a real code change still blocks the reviewer');
});

test('Seatbelt (macOS): file-level denies with names visible, template and custom, agree after one refresh inside', (t) => {
  const sb = sandbox();
  write(sb, '.env.dev', 'API=1\n');
  write(sb, 'config/.env.stg', 'API=2\n');
  write(sb, 'vault/token.txt', 'x\n');
  commitAll(sb);
  write(sb, 'vault/new-local.txt', 'not committed, not ignored\n');
  const profile = seatbelt(sb, ['vault/[^/]+\\.txt$']);
  if (!seatbeltWorks(sb, profile, 'vault/token.txt')) return t.skip('needs macOS sandbox-exec');
  blockProfile(sb);
  startRun(sb);

  // The stamp was written outside, where vault/new-local.txt can be read; inside it cannot.
  const first = JSON.parse(feSeatbelt(sb, profile, ['graph', 'status', '--json']).out);
  assert.deepEqual(first.unreadable_paths, ['vault/new-local.txt', 'vault/token.txt']);
  assert.equal(first.fresh, false, 'the first inside check after an outside stamp refreshes once');
  const ens = feSeatbelt(sb, profile, ['graph', 'ensure']);
  assert.equal(ens.code, 0, ens.err);

  assert.equal(JSON.parse(feSeatbelt(sb, profile, ['graph', 'status', '--json']).out).fresh, true, 'inside');
  assert.equal(graphStatus(sb).fresh, true, 'outside, leaving out what the stamp could not read');
  assert.equal(review(sb), null, 'G10 does not block');
  assert.doesNotMatch(sessionContext(sb), /may not match the code/);

  write(sb, '.env.dev', 'API=edited outside\n');
  assert.equal(graphStatus(sb).fresh, true, 'a template-denied file edited outside');
  assert.equal(JSON.parse(feSeatbelt(sb, profile, ['graph', 'status', '--json']).out).fresh, true);
  write(sb, 'src/features/profile/Badge.tsx', 'export const Badge = () => null;\n');
  assert.equal(JSON.parse(feSeatbelt(sb, profile, ['graph', 'status', '--json']).out).fresh, false, 'code still counts inside');
  assert.ok(denied(review(sb)), 'and outside');
});

test('too many unreadable paths make the graph stale with a reason, never fresh by accident', (t) => {
  const sb = sandbox();
  write(sb, 'a/x.txt', 'x\n');
  write(sb, 'b/y.txt', 'y\n');
  commitAll(sb);
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  const env = { FE_DELIVERY_UNREADABLE_MAX: '1' };
  const ran = insideSandbox(sb, ['a', 'b'], 'a/x.txt', () => {
    process.env.FE_DELIVERY_UNREADABLE_MAX = '1';
    try {
      const s = worktreeStamp(sb.repo);
      assert.equal(s.fingerprint, null);
      assert.match(s.error, /2 paths are unreadable here, too many to leave out/);
    } finally {
      delete process.env.FE_DELIVERY_UNREADABLE_MAX;
    }
    assert.notEqual(worktreeStamp(sb.repo).fingerprint, null, 'within the limit, the two folders are left out');
    const s = graphStatus(sb, env);
    assert.equal(s.fresh, false);
    assert.match(s.reason, /could not be fingerprinted .*too many/);
    const res = fe({ ...sb, env: { ...sb.env, ...env } }, ['graph', 'ensure']);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /Warning: the working tree could not be fingerprinted/);
    assert.equal(graphStatus(sb, env).fresh, false, 'still stale after the refresh: loud, not silently fresh');
  });
  if (!ran) t.skip('directory permissions do not apply to this user');
});

test('the fingerprint leaves out every file the settings template denies reading', () => {
  const settings = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'templates', 'settings.example.json'), 'utf8'));
  const deniedReads = settings.permissions.deny
    .map((rule) => /^Read\((.+)\)$/.exec(rule)?.[1])
    .filter((p) => p && !p.startsWith('!'));
  assert.ok(deniedReads.length >= 4, JSON.stringify(deniedReads));
  for (const p of deniedReads) assert.ok(SECRET_GLOBS.includes(`**/${p}`), `Read(${p}) is denied but counted in the fingerprint`);
});

test('a pilothify crash shows its error line and where the full output is', () => {
  const sb = sandbox();
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  const res = fe({ ...sb, env: { ...sb.env, FE_STUB_PILOTHIFY_MODE: 'traceback' } }, ['graph', 'ensure']);
  assert.equal(res.code, 1);
  assert.match(res.err, /pilothify update \. failed \(exit 1\): PermissionError: \[Errno 1\] Operation not permitted: '[^']+\/graph\.lock'/);
  assert.doesNotMatch(res.err, /File "|Traceback|\|/, 'frames stay in the log');
  const log = /\(full output: (.+\.last-failure\.log)\)/.exec(res.err)?.[1];
  assert.ok(log && existsSync(log), res.err);
  const text = readFileSync(log, 'utf8');
  assert.match(text, /^\$ pilothify update \.\n# exit 1 at /);
  assert.match(text, /Traceback \(most recent call last\):[\s\S]*watch\.py[\s\S]*PermissionError/);
  assert.match(text, /\[pilothify\] scanning 3 files/, 'stdout is kept too');
});

test('a pilothify killed by a signal says so, without taking a file name for the error', () => {
  const sb = sandbox();
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  const res = fe({ ...sb, env: { ...sb.env, FE_STUB_PILOTHIFY_MODE: 'killed' } }, ['graph', 'ensure']);
  assert.equal(res.code, 1);
  assert.match(res.err, /pilothify update \. failed \(killed by SIGKILL\): \[pilothify\] parsing src\/utils\/format\.ts \(full output: /);
});

test('failureLine names the failure, which is rarely the last line', () => {
  const traceback = (frames, last) => ['Traceback (most recent call last):', ...frames.flatMap((f) => [`  File "${f}.py", line 3, in ${f}`, `    ${f}()`]), last];
  const cases = [
    [[...traceback(['cli'], "PermissionError: [Errno 1] Operation not permitted: 'x'"), '[pilothify] wrote a partial cache', ''],
      "PermissionError: [Errno 1] Operation not permitted: 'x'"],
    [[...traceback(['load'], 'OSError: disk full'), '', 'The above exception was the direct cause of the following exception:', '',
      ...traceback(['main'], 'pilothify.errors.BuildFailed: could not write graph.json'), '[pilothify] cleaning up'],
      'pilothify.errors.BuildFailed: could not write graph.json'],
    [[...traceback(['f'], 'ValueError: first line of the message'), 'second line of the message'], 'ValueError: first line of the message'],
    [['  + Exception Group Traceback (most recent call last):', '  |   File "a.py", line 2, in <module>', '  |     run()',
      '  | ExceptionGroup: two failures (2 sub-exceptions)', '  +-+---------------- 1 ----------------',
      '    | Traceback (most recent call last):', '    |   File "a.py", line 5, in f', '    | ValueError: a',
      '    +---------------- 2 ----------------', '    | TypeError: b', '    +------------------------------------'],
      'ExceptionGroup: two failures (2 sub-exceptions)'],
    [['[pilothify] reading', 'error: unknown update option: --full', '[pilothify] see pilothify update --help'], 'error: unknown update option: --full'],
    [['[pilothify] parsing src/utils/error.ts', '[pilothify] parsing src/utils/format.ts'], '[pilothify] parsing src/utils/format.ts'],
    [['fatal: not a git repository (or any of the parent directories): .git', 'usage: pilothify update [path]'], 'fatal: not a git repository (or any of the parent directories): .git'],
    [['[pilothify] parsing a.ts', ...traceback(['parse'], 'ValueError: bad token in a.ts'), '[pilothify] parsing b.ts', 'error: 2 files failed to parse'],
      'error: 2 files failed to parse'],
    [[...traceback(['cli'], "KeyError: 'x'"), '', 'error: rebuild aborted'], 'error: rebuild aborted'],
    [['  + Exception Group Traceback (most recent call last):', '  |   File "x.py", line 9, in <module>', '  | ExceptionGroup: outer (1 sub-exception)',
      '  +-+---------------- 1 ----------------', '    | Exception Group Traceback (most recent call last):', '    |   File "x.py", line 5, in f',
      '    | ExceptionGroup: inner (1 sub-exception)', '    +-+---------------- 1 ----------------', '      | ValueError: v',
      '      +------------------------------------'], 'ExceptionGroup: outer (1 sub-exception)'],
    [['Traceback (most recent call last):', '  File "x.py", line 1, in <module>', '    run()'],
      'a Python traceback that ends before its exception line (see the full output)'],
    [['Traceback (most recent call last):', '  File "x.py", line 1, in <module>', '\x1b[35mPermissionError\x1b[0m: \x1b[35mdenied\x1b[0m'], 'PermissionError: denied'],
    [[''], '(no output)'],
  ];
  for (const [lines, expected] of cases) assert.equal(failureLine(lines.join('\n')), expected, lines.join('\n'));
});

test('a stamp cannot carry "." (or a malformed unit) to hide every change', () => {
  const sb = sandbox();
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  const dir = join(sb.home, 'agent');
  const file = readdirSync(dir).map((k) => join(dir, k, 'graph')).filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => join(d, f)))[0];
  assert.ok(file, 'stamp file');
  write(sb, 'src/features/profile/Badge.tsx', 'export const Badge = () => null;\n');
  for (const unit of ['.', './src', 'src/', '', '/']) {
    const stamp = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...stamp, unreadable: [unit] }));
    assert.equal(graphStatus(sb).fresh, false, `unit ${JSON.stringify(unit)} must not hide the edit`);
  }
});

test('when git itself fails, the fingerprint is null and the graph reads as stale', (t) => {
  const sb = sandbox();
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  const index = join(sb.repo, '.git', 'index');
  chmodSync(index, 0o000);
  try {
    try {
      readFileSync(index);
      return t.skip('file permissions do not apply to this user');
    } catch {
      // the index is unreadable, as intended
    }
    const s = worktreeStamp(sb.repo);
    assert.equal(s.fingerprint, null);
    assert.match(s.error, /git (diff|status) failed/);
    const g = graphStatus(sb);
    assert.equal(g.fresh, false);
    assert.match(g.reason, /could not be fingerprinted/);
  } finally {
    chmodSync(index, 0o644);
  }
});
