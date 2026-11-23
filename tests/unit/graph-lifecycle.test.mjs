// v0.4.0: query the graph before reading code (A), keep the graph in step with the code (B),
// and full rebuilds that clear what incremental updates leave behind (C). Items 1–13 refer to
// the "Yêu cầu" list of the change request. pilothify is the test double in tests/fixtures/bin.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSchema, validate } from '../../scripts/lib/schema.mjs';
import { treeChangingGit } from '../../scripts/rules/post.mjs';
import {
  PLUGIN_ROOT, STUB_BIN, classify, denied, editPost, fe, feViaBash, hook, reason, sandbox, setProfile, startRun,
  stubCalls, waitFor, write,
} from '../helpers.mjs';

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;

const runStatus = (sb) => JSON.parse(fe(sb, ['run', 'status', '--json']).out);
const graphStatus = (sb) => JSON.parse(fe(sb, ['graph', 'status', '--json']).out);
const rebuilds = (sb) => stubCalls(sb).filter((c) => c.argv[0] === 'update' || c.argv[0] === 'extract').map((c) => c.argv.join(' '));
const bash = (sb, command, extra = {}) => hook(sb, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command }, ...extra });
const INTAKE_AGENT = { agent_type: 'fe-delivery:fe-intake', agent_id: 'intake-1' };
const context = (out) => out?.hookSpecificOutput?.additionalContext || '';
const no = (out, re) => {
  assert.ok(denied(out), `expected deny, got ${JSON.stringify(out)}`);
  if (re) assert.match(reason(out), re);
};
const intakeJson = (codebase) => JSON.stringify({
  requirements: [{ text: 'Show profile', kind: 'explicit', source: 'jira' }],
  open_questions: [],
  conflicts: [],
  instructions_found_not_followed: [],
  pii_removed: true,
  ...(codebase ? { codebase } : {}),
});
const QUERIES = {
  queries: [
    { question: 'ProfileCard Button', command: 'query', exit_code: 0, nodes: ['src_features_profile_profilecard'] },
    { question: 'Avatar', command: 'explain', exit_code: 3 },
    { question: 'zzBadgeVariant', command: 'query', exit_code: 4, fallback: { tool: 'grep', pattern: 'BadgeVariant', paths: ['src/'] } },
  ],
};
const intakeSave = (sb, codebase) => fe(sb, ['intake', 'save', '-'], { stdin: intakeJson(codebase) });

// The intake agent runs a graph query (the PreToolUse hook records it).
function intakeQueries(sb, question = 'ProfileCard Button') {
  assert.equal(bash(sb, `pilothify query "${question}" --budget 2000`, INTAKE_AGENT), null);
}

function blockProfile(sb) {
  setProfile(sb, (p) => { p.graph = { enforce: 'block' }; });
}

// ---------------------------------------------------------------- A. query first

test('1 (warn): intake save warns about a missing graph step but saves the intake', () => {
  const sb = sandbox();
  startRun(sb);
  const empty = intakeSave(sb);
  assert.equal(empty.code, 0, empty.err);
  assert.match(empty.out, /warning: .*codebase\.queries is empty/);
  const noFallback = intakeSave(sb, { queries: [{ question: 'zzProfile', exit_code: 4 }] });
  assert.equal(noFallback.code, 0, noFallback.err);
  assert.match(noFallback.out, /warning: query "zzProfile" exited 4 .*no grep fallback/);
  assert.match(noFallback.out, /warning: .*no pilothify query was run in this run/);
  assert.ok(runStatus(sb).graph.warnings.length >= 3, 'warnings are kept for the report');
});

test('1 (block): intake save refuses without queries, with an exit-4 query lacking a fallback, or when no query ran', () => {
  const sb = sandbox();
  blockProfile(sb);
  startRun(sb);
  const empty = intakeSave(sb);
  assert.equal(empty.code, 1);
  assert.match(empty.err, /codebase\.queries is empty/);
  const noFallback = intakeSave(sb, { queries: [{ question: 'zzProfile', exit_code: 4 }] });
  assert.equal(noFallback.code, 1);
  assert.match(noFallback.err, /exited 4 .*no grep fallback/);
  const unseen = intakeSave(sb, QUERIES);
  assert.equal(unseen.code, 1, 'queries the hooks never saw are not accepted');
  assert.match(unseen.err, /no pilothify query was run in this run/);
  const early = classify(sb, { model_tier: 'trivial', predicted_files: ['src/App.tsx'] });
  assert.equal(early.code, 1, 'block: no classification before an accepted intake');
  assert.match(early.err, /save the intake first/);
  intakeQueries(sb);
  const ok = intakeSave(sb, QUERIES);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Intake saved/);
});

test('1: the intake schema requires question and exit code per query, and describes the grep fallback', () => {
  const schema = loadSchema('intake');
  const base = JSON.parse(intakeJson());
  assert.deepEqual(validate(schema, { ...base, run_id: 'r', codebase: QUERIES }), []);
  assert.ok(validate(schema, { ...base, run_id: 'r', codebase: { queries: [{ question: 'x' }] } }).some((e) => /exit_code/.test(e)));
  assert.ok(validate(schema, { ...base, run_id: 'r', codebase: { queries: [{ question: 'x', exit_code: 4, fallback: { tool: 'grep' } }] } })
    .some((e) => /pattern/.test(e)));
});

test('2 (block): fe-intake may not search with grep/rg/find/Grep/Glob before the run has a graph query', () => {
  const sb = sandbox();
  blockProfile(sb);
  startRun(sb);
  const G9 = /\[G9\].*query the graph first.*exit 4/;
  no(bash(sb, 'grep -rn ProfileCard src', INTAKE_AGENT), G9);
  no(bash(sb, 'rg ProfileCard src', INTAKE_AGENT), G9);
  no(bash(sb, 'find src -name "*.tsx"', INTAKE_AGENT), G9);
  no(bash(sb, 'git grep ProfileCard', INTAKE_AGENT), G9);
  no(hook(sb, 'pre-tool-use', { tool_name: 'Grep', tool_input: { pattern: 'ProfileCard' }, ...INTAKE_AGENT }), G9);
  no(hook(sb, 'pre-tool-use', { tool_name: 'Glob', tool_input: { pattern: 'src/**/*.tsx' }, ...INTAKE_AGENT }), G9);
  assert.equal(bash(sb, 'grep -rn ProfileCard src'), null, 'the conductor is not restricted');
  assert.equal(bash(sb, 'cat src/App.tsx', INTAKE_AGENT), null, 'reading a known file is not a search');
  intakeQueries(sb, 'zzNothingMatches');
  assert.equal(bash(sb, 'grep -rn ProfileCard src', INTAKE_AGENT), null, 'bounded grep after a query (exit 4 fallback)');
  assert.equal(hook(sb, 'pre-tool-use', { tool_name: 'Grep', tool_input: { pattern: 'x' }, ...INTAKE_AGENT }), null);
});

test('2 (warn): the same search is allowed with a nudge, and recorded for the report', () => {
  const sb = sandbox();
  startRun(sb);
  const out = bash(sb, 'grep -rn ProfileCard src', INTAKE_AGENT);
  assert.ok(!denied(out));
  assert.match(context(out), /query the graph first/);
  const glob = hook(sb, 'pre-tool-use', { tool_name: 'Glob', tool_input: { pattern: '**/*.tsx' }, ...INTAKE_AGENT });
  assert.ok(!denied(glob));
  assert.ok(runStatus(sb).graph.searches_before_query >= 2);
});

test('2: the PreToolUse matcher covers Grep, Glob and subagent launches', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const matcher = hooks.hooks.PreToolUse[0].matcher.split('|');
  for (const tool of ['Grep', 'Glob', 'Agent', 'Task', 'Bash']) assert.ok(matcher.includes(tool), tool);
});

test('3: the report shows refreshes, queries by exit code, the grep fallback and freshness', () => {
  const sb = sandbox();
  startRun(sb);
  intakeQueries(sb);
  assert.equal(intakeSave(sb, QUERIES).code, 0);
  classify(sb, { model_tier: 'trivial', predicted_files: ['src/features/profile/ProfileCard.tsx'] });
  const rep = fe(sb, ['report']).out;
  assert.match(rep, /## Graph/);
  assert.match(rep, /- Refreshes: \d+ \(full 1, incremental \d+, unchanged \d+, failed 0\)/);
  assert.match(rep, /- Intake queries: 3 \(exit 0: 1, exit 3: 1, exit 4: 1\); grep fallback: yes \(1\)/);
  assert.match(rep, /- Queries run in this run \(seen by hooks\): 1/);
  assert.match(rep, /- Graph vs working tree: fresh \(HEAD [0-9a-f]{7}/);
});

// ---------------------------------------------------------------- B. graph follows the code

test('4: the freshness stamp covers HEAD and the working tree; graph ensure records it in the run', () => {
  const sb = sandbox();
  startRun(sb);
  assert.equal(graphStatus(sb).fresh, true);
  write(sb, 'src/features/profile/Avatar.tsx', 'export const Avatar = () => null;\n');
  let g = graphStatus(sb);
  assert.equal(g.fresh, false, 'an uncommitted file makes the graph stale though HEAD did not move');
  assert.match(g.reason, /working tree changed/);
  const ens = fe(sb, ['graph', 'ensure']);
  assert.equal(ens.code, 0, ens.err);
  assert.equal(graphStatus(sb).fresh, true);
  const last = runStatus(sb).graph.last;
  for (const k of ['head', 'fingerprint', 'mode', 'at', 'exit', 'nodes']) assert.ok(k in last, k);
  assert.equal(last.mode, 'incremental');
  assert.equal(last.exit, 0);
  rmSync(join(sb.repo, 'src/features/profile/Avatar.tsx'));
  g = graphStatus(sb);
  assert.equal(g.fresh, false, 'a graph that still has discarded code is stale too');
});

test('5: a graph whose built_at_commit is null is stale, at session start and in graph status', () => {
  const sb = sandbox();
  write(sb, 'pilothify-out/graph.json', JSON.stringify({ nodes: [], links: [], built_at_commit: null }));
  const ctx = context(hook(sb, 'session-start', {}));
  assert.match(ctx, /pilothify graph may not match the code .*built_at_commit/);
  const g = graphStatus(sb);
  assert.equal(g.fresh, false);
  assert.match(g.reason, /built_at_commit/);
});

test('6: fe git-hooks install runs pilothify hook install --no-merge-driver; doctor reports it; uninstall removes only its own', () => {
  const sb = sandbox();
  assert.match(fe(sb, ['doctor']).out, /pilothify git hooks: not installed/);
  const inst = fe(sb, ['git-hooks', 'install']);
  assert.equal(inst.code, 0, inst.err);
  assert.ok(stubCalls(sb).some((c) => c.argv.join(' ') === 'hook install --no-merge-driver'));
  assert.ok(readFileSync(join(sb.repo, '.git', 'hooks', 'post-checkout'), 'utf8').includes('# pilothify-checkout-hook-start'));
  assert.ok(!existsSync(join(sb.repo, '.gitattributes')));
  assert.match(fe(sb, ['doctor']).out, /pilothify git hooks: installed by fe-delivery/);
  const un = fe(sb, ['git-hooks', 'uninstall']);
  assert.equal(un.code, 0, un.err);
  assert.ok(!existsSync(join(sb.repo, '.git', 'hooks', 'post-checkout')));
  execFileSync(join(STUB_BIN, 'pilothify'), ['hook', 'install'], { cwd: sb.repo, env: sb.env });
  const foreign = fe(sb, ['git-hooks', 'uninstall']);
  assert.match(foreign.out, /not installed by fe-delivery; left in place/);
  assert.ok(existsSync(join(sb.repo, '.git', 'hooks', 'post-checkout')));
  assert.match(fe(sb, ['doctor']).out, /pilothify git hooks: installed \(not managed by fe-delivery\)/);
});

test('6: fe uninstall removes the pilothify git hooks fe-delivery installed in this clone', () => {
  const sb = sandbox();
  const profile = readFileSync(join(sb.repo, '.fe-delivery', 'profile.json'), 'utf8');
  rmSync(join(sb.repo, '.fe-delivery'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: sb.repo, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-qm', 'no fe-delivery yet');
  assert.equal(fe(sb, ['install', '--profile', '-'], { stdin: profile }).code, 0);
  git('add', '-A');
  git('commit', '-qm', 'install fe-delivery');
  assert.equal(fe(sb, ['git-hooks', 'install']).code, 0);
  const dry = fe(sb, ['uninstall', '--dry-run']);
  assert.match(dry.out, /remove-hooks\s+\S+hooks — pilothify git hooks installed by fe-delivery/);
  const un = fe(sb, ['uninstall']);
  assert.equal(un.code, 0, un.out + un.err);
  assert.match(un.out, /git hooks: Removed the pilothify git hooks fe-delivery installed/);
  assert.ok(!existsSync(join(sb.repo, '.git', 'hooks', 'post-commit')));
  assert.match(un.out, /Safety check passed/);
});

test('6: session start nudges to install the git hooks unless the profile opts out; settings set the rebuild log', () => {
  const sb = sandbox();
  assert.match(context(hook(sb, 'session-start', {})), /pilothify git hooks are not installed in this clone.*git-hooks install/);
  setProfile(sb, (p) => { p.graph = { git_hooks: false }; });
  assert.doesNotMatch(context(hook(sb, 'session-start', {})), /git hooks are not installed/);
  const settings = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'templates', 'settings.example.json'), 'utf8'));
  assert.equal(settings.env.PILOTHIFY_REBUILD_LOG, 'pilothify-out/rebuild.log');
});

function holdLock(sb, ms) {
  const out = join(sb.repo, 'pilothify-out');
  const lock = join(out, '.rebuild.lock');
  mkdirSync(out, { recursive: true });
  const child = spawn(process.execPath, ['-e', [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(lock)}, process.pid + '\\n');`,
    `setTimeout(() => fs.rmSync(${JSON.stringify(lock)}, { force: true }), ${ms});`,
  ].join('')], { stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  while (!existsSync(lock) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  return { child, lock };
}

test('7: graph ensure and classify wait for a running pilothify rebuild before reading the graph', () => {
  const sb = sandbox();
  startRun(sb);
  write(sb, 'src/features/profile/Avatar.tsx', 'export const Avatar = () => null;\n');
  holdLock(sb, 900);
  const t0 = Date.now();
  const res = classify(sb, { model_tier: 'trivial', predicted_files: ['src/features/profile/Avatar.tsx'] });
  assert.equal(res.code, 0, res.err);
  assert.ok(Date.now() - t0 >= 700, 'classify returned before the rebuild lock was released');
  assert.match(res.out, /waiting for the pilothify rebuild \(pid \d+\)/);
  assert.equal(graphStatus(sb).fresh, true);
});

test('7: a lock held past the timeout fails clearly; a stale lock left by a dead process does not wait', () => {
  const sb = sandbox({ FE_DELIVERY_GRAPH_LOCK_TIMEOUT_MS: '400' });
  fe(sb, ['graph', 'ensure']);
  const before = rebuilds(sb).length;
  const { child } = holdLock(sb, 5000);
  const res = fe(sb, ['graph', 'ensure']);
  child.kill();
  assert.equal(res.code, 1);
  assert.match(res.err, /pilothify-out\/\.rebuild\.lock is still held by pid \d+ after 0\.4 s/);
  assert.equal(rebuilds(sb).length, before, 'no rebuild was started while the lock was held');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  write(sb, 'pilothify-out/.rebuild.lock', `${dead}\n`);
  const t0 = Date.now();
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  assert.ok(Date.now() - t0 < 2000, 'a dead holder is not waited for');
});

test('8: a git command that changes the working tree refreshes the graph in the background', async () => {
  const sb = sandbox();
  startRun(sb);
  const before = rebuilds(sb).length;
  const out = hook(sb, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: 'git stash' }, tool_response: { stdout: '' } });
  assert.match(context(out), /refreshing in the background/);
  assert.ok(await waitFor(() => rebuilds(sb).length > before), 'background refresh did not run');
  assert.equal(rebuilds(sb).at(-1), 'update .');
  const after = rebuilds(sb).length;
  assert.equal(hook(sb, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: { stdout: '' } }), null);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rebuilds(sb).length, after);
});

test('8: tree-changing git commands are recognised through options and chains', () => {
  assert.equal(treeChangingGit('git checkout main'), 'checkout');
  assert.equal(treeChangingGit('git -C . -c core.quotePath=false switch -c feature/x'), 'switch');
  assert.equal(treeChangingGit('git fetch && git pull --rebase'), 'pull');
  assert.equal(treeChangingGit('git reset --hard HEAD~1'), 'reset');
  assert.equal(treeChangingGit('git restore src/App.tsx'), 'restore');
  assert.equal(treeChangingGit('git cherry-pick abc123'), 'cherry-pick');
  assert.equal(treeChangingGit('git stash pop'), 'stash');
  assert.equal(treeChangingGit('git stash list'), null);
  assert.equal(treeChangingGit('git log --oneline'), null);
  assert.equal(treeChangingGit('echo git checkout main'), null);
});

test('9: run start rebuilds fully; classify, verify and run end update only when the tree changed; edits do not', () => {
  const sb = sandbox();
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  assert.deepEqual(rebuilds(sb), ['extract . --code-only'], 'the first build of a repository');
  startRun(sb);
  assert.equal(rebuilds(sb).at(-1), 'update . --full', 'run start rebuilds fully');
  const n = rebuilds(sb).length;
  assert.equal(classify(sb, { model_tier: 'trivial', predicted_files: ['src/components/Button.tsx'] }).code, 0);
  assert.equal(rebuilds(sb).length, n, 'nothing changed since run start: no update');
  write(sb, 'src/components/Button.tsx', 'export const Button = () => null;\nexport const Extra = 1;\n');
  editPost(sb, 'src/components/Button.tsx');
  assert.equal(rebuilds(sb).length, n, 'an edit does not update the graph');
  const c3 = fe(sb, ['classify', '-', '--checkpoint', 'C3'], { stdin: classifyInput() });
  assert.equal(c3.code, 0, c3.err);
  assert.equal(rebuilds(sb).at(-1), 'update .', 'C3 re-classify updates incrementally');
  write(sb, 'src/components/Button.tsx', 'export const Button = () => null;\nexport const Extra = 2;\n');
  editPost(sb, 'src/components/Button.tsx');
  const m = rebuilds(sb).length;
  feViaBash(sb, ['verify']);
  assert.equal(rebuilds(sb).length, m + 1, 'verify updates before the checks and the reviewer');
  write(sb, 'src/components/Button.tsx', 'export const Button = () => null;\nexport const Extra = 3;\n');
  editPost(sb, 'src/components/Button.tsx');
  const k = rebuilds(sb).length;
  feViaBash(sb, ['run', 'end']);
  assert.equal(rebuilds(sb).length, k + 1, 'run end leaves a graph that matches the working tree');
});

function classifyInput() {
  return JSON.stringify({
    task_type: 'feature',
    model_tier: 'trivial',
    size: {
      scope: { score: 0, evidence: 'one component' },
      logic_state: { score: 0, evidence: 'presentational' },
      data_api: { score: 0, evidence: 'none' },
      design: { score: 0, evidence: 'existing' },
    },
    predicted_files: ['src/components/Button.tsx'],
    reason: 'C3 after the diff grew',
  });
}

test('9: the fe-reviewer launch is refused (block) or flagged (warn) while the graph is stale', () => {
  const sb = sandbox();
  blockProfile(sb);
  startRun(sb);
  const review = () => hook(sb, 'pre-tool-use', { tool_name: 'Agent', tool_input: { subagent_type: 'fe-delivery:fe-reviewer', prompt: 'review' } });
  assert.equal(review(), null);
  write(sb, 'src/features/profile/Avatar.tsx', 'export const Avatar = () => null;\n');
  no(review(), /\[G10\].*fe graph ensure/);
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  assert.equal(review(), null);
  const warn = sandbox();
  startRun(warn);
  write(warn, 'src/features/profile/Avatar.tsx', 'export const Avatar = () => null;\n');
  const out = hook(warn, 'pre-tool-use', { tool_name: 'Task', tool_input: { subagent_type: 'fe-reviewer' } });
  assert.ok(!denied(out));
  assert.match(context(out), /graph is stale.*fe graph ensure/);
});

test('10: in a linked worktree, where pilothify hooks skip rebuilds, fe still updates the graph', () => {
  const sb = sandbox();
  const wtPath = join(sb.base, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-branch', wtPath], { cwd: sb.repo });
  const wt = { ...sb, repo: wtPath };
  assert.equal(fe(wt, ['graph', 'ensure']).code, 0);
  const g = graphStatus(wt);
  assert.equal(g.linked_worktree, true);
  assert.match(context(hook(wt, 'session-start', {})), /linked worktree.*fe refreshes the graph/);
  startRun(wt);
  write(wt, 'src/features/profile/Avatar.tsx', 'export const Avatar = () => null;\n');
  const before = stubCalls(wt).length;
  assert.equal(classify(wt, { model_tier: 'trivial', predicted_files: ['src/features/profile/Avatar.tsx'] }).code, 0);
  const call = stubCalls(wt).slice(before).find((c) => c.argv[0] === 'update');
  assert.ok(call, 'no update in the worktree');
  assert.equal(call.cwd, wtPath);
  assert.equal(graphStatus(wt).fresh, true);
});

test('11: a refused write is an error, not "exit 0"', () => {
  const sb = sandbox();
  assert.equal(fe(sb, ['graph', 'ensure']).code, 0);
  write(sb, 'src/features/profile/Avatar.tsx', 'export const Avatar = () => null;\n');
  for (const mode of ['refuse', 'refuse0', 'fail']) {
    const res = fe({ ...sb, env: { ...sb.env, FE_STUB_PILOTHIFY_MODE: mode } }, ['graph', 'ensure']);
    assert.equal(res.code, 1, `${mode}: ${res.out}`);
    assert.match(res.err, mode === 'fail' ? /pilothify update \. failed \(exit 1\)/ : /pilothify refused to write the graph/);
    assert.doesNotMatch(res.out, /exit 0/);
    assert.equal(graphStatus(sb).fresh, false, 'a refused update does not mark the graph fresh');
  }
});

test('12: graph ensure --full uses update --full, and --force on pilothify older than 0.1.6', () => {
  const sb = sandbox();
  fe(sb, ['graph', 'ensure']);
  assert.equal(fe(sb, ['graph', 'ensure', '--full']).code, 0);
  assert.equal(rebuilds(sb).at(-1), 'update . --full');
  const old = { ...sb, env: { ...sb.env, FE_STUB_PILOTHIFY_VERSION: '0.1.5' } };
  const res = fe(old, ['graph', 'ensure', '--full']);
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(rebuilds(sb).slice(-2), ['update . --full', 'update . --force']);
  assert.match(res.out, /pilothify 0\.1\.5 has no --full; used --force/);
});

test('13: profile graph.enforce is off | warn | block, warn by default; off skips the graph work', () => {
  const schema = loadSchema('profile');
  const profile = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'templates', 'profile.example.json'), 'utf8'));
  assert.deepEqual(validate(schema, { ...profile, graph: { enforce: 'block', git_hooks: false } }), []);
  assert.ok(validate(schema, { ...profile, graph: { enforce: 'strict' } }).length > 0);
  const sb = sandbox();
  startRun(sb);
  assert.equal(runStatus(sb).graph.enforce, 'warn');
  const off = sandbox();
  setProfile(off, (p) => { p.graph = { enforce: 'off' }; });
  startRun(off);
  assert.equal(runStatus(off).graph.enforce, 'off');
  assert.deepEqual(rebuilds(off), [], 'off: no refresh at run start');
  const saved = intakeSave(off);
  assert.equal(saved.code, 0);
  assert.doesNotMatch(saved.out, /warning/);
});

// ---------------------------------------------------------------- definition of done

test('DoD: a branch switched mid-session is in the graph before intake (run start)', () => {
  const sb = sandbox();
  fe(sb, ['graph', 'ensure']);
  const git = (...a) => execFileSync('git', a, { cwd: sb.repo, encoding: 'utf8' }).trim();
  git('switch', '-q', '-c', 'feature/other');
  write(sb, 'src/features/other/Other.tsx', 'export const Other = () => null;\n');
  git('add', '-A');
  git('commit', '-qm', 'other');
  assert.equal(graphStatus(sb).fresh, false);
  startRun(sb, 'PROJ-2');
  const g = graphStatus(sb);
  assert.equal(g.fresh, true);
  assert.equal(g.head, git('rev-parse', 'HEAD'));
  const graph = JSON.parse(readFileSync(join(sb.repo, 'pilothify-out', 'graph.json'), 'utf8'));
  assert.ok(graph.nodes.some((n) => n.source_file === 'src/features/other/Other.tsx'));
});

test('DoD: a component added during the task is in the graph the reviewer reads', () => {
  const sb = sandbox();
  startRun(sb);
  classify(sb, { model_tier: 'trivial', predicted_files: ['src/components/Badge.tsx'] });
  write(sb, 'src/components/Badge.tsx', 'export const Badge = () => null;\n');
  editPost(sb, 'src/components/Badge.tsx');
  feViaBash(sb, ['verify']);
  const graph = JSON.parse(readFileSync(join(sb.repo, 'pilothify-out', 'graph.json'), 'utf8'));
  assert.ok(graph.nodes.some((n) => n.label === 'Badge'), 'the new component is in the graph');
  assert.equal(hook(sb, 'pre-tool-use', { tool_name: 'Agent', tool_input: { subagent_type: 'fe-reviewer' } }), null);
});

test('DoD: run status and doctor show the graph state', () => {
  const sb = sandbox();
  startRun(sb);
  const g = runStatus(sb).graph;
  assert.equal(g.enforce, 'warn');
  assert.equal(g.fresh, true);
  assert.equal(g.refreshes, 1);
  const doc = fe(sb, ['doctor']).out;
  assert.match(doc, /graph: fresh/);
  assert.match(doc, /graph lock: free/);
  assert.match(doc, /graph\.enforce: warn/);
});
