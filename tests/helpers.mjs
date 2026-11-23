import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FE = join(PLUGIN_ROOT, 'scripts', 'fe.mjs');
export const HOOK = join(PLUGIN_ROOT, 'scripts', 'hook.mjs');
export const FIXTURE = join(PLUGIN_ROOT, 'tests', 'fixtures', 'fe-app');
// A pilothify test double (tests/fixtures/bin/pilothify) comes first on PATH, so unit
// tests never run the real CLI. It logs each call to <base>/pilothify-calls.jsonl.
export const STUB_BIN = join(PLUGIN_ROOT, 'tests', 'fixtures', 'bin');

export function sandbox(extraEnv = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fe-delivery-test-')));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  cpSync(FIXTURE, repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'test');
  g('add', '-A');
  g('commit', '-qm', 'fixture');
  const env = {
    ...process.env,
    PATH: `${STUB_BIN}${delimiter}${process.env.PATH || ''}`,
    FE_DELIVERY_HOME: home,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    FE_DELIVERY_NO_REFRESH: '1',
    FE_STUB_PILOTHIFY_LOG: join(base, 'pilothify-calls.jsonl'),
    FE_GRAPH_REFRESH_DELAY_MS: '0',
    ...extraEnv,
  };
  return { base, home, repo, env };
}

// Calls the pilothify test double received, oldest first: [{argv, cwd, at, backend}].
export function stubCalls(sb) {
  try {
    return readFileSync(sb.env.FE_STUB_PILOTHIFY_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function waitFor(predicate, timeoutMs = 8000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

export function hook(sb, event, input) {
  const res = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify({ cwd: sb.repo, session_id: 'sess-1', ...input }),
    env: sb.env,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`hook ${event} exited ${res.status}: ${res.stderr}`);
  const line = res.stdout.trim().split('\n').filter(Boolean).pop();
  return line ? JSON.parse(line) : null;
}

export function fe(sb, args, { stdin } = {}) {
  const res = spawnSync(process.execPath, [FE, ...args], {
    cwd: sb.repo,
    env: sb.env,
    input: stdin,
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

// Runs an fe CLI command and feeds its output to the PostToolUse hook, as Claude Code would.
export function feViaBash(sb, args, opts) {
  const res = fe(sb, args, opts);
  const command = `node "${FE}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  const post = hook(sb, 'post-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: res.out, stderr: res.err } });
  return { ...res, post, command };
}

export function denied(out) {
  return out?.hookSpecificOutput?.permissionDecision === 'deny';
}

export function reason(out) {
  return out?.hookSpecificOutput?.permissionDecisionReason || out?.reason || '';
}

export function write(sb, rel, text) {
  const file = join(sb.repo, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

// Rewrites the repository's profile (as a team would commit it) before a run starts.
export function setProfile(sb, mutate) {
  const file = join(sb.repo, '.fe-delivery', 'profile.json');
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  mutate(profile);
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  return profile;
}

export function editPre(sb, rel, extra = {}) {
  return hook(sb, 'pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: join(sb.repo, rel) }, ...extra });
}

export function editPost(sb, rel) {
  return hook(sb, 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path: join(sb.repo, rel) }, tool_response: {} });
}

export const SIZE = {
  scope: { score: 1, evidence: 'one page' },
  logic_state: { score: 0, evidence: 'presentational' },
  data_api: { score: 0, evidence: 'existing client' },
  design: { score: 1, evidence: 'reuses Button' },
};

export function startRun(sb, key = 'PROJ-1') {
  const r = feViaBash(sb, ['run', 'start', '--jira', key]);
  const m = r.out.match(/FE_RUN_STARTED (\{.*\})/);
  if (!m) throw new Error(`run start failed: ${r.out} ${r.err}`);
  return JSON.parse(m[1]).run_id;
}

export function classify(sb, input) {
  return fe(sb, ['classify', '-'], { stdin: JSON.stringify({ task_type: 'feature', size: SIZE, ...input }) });
}

export function featureArtifacts(sb, names) {
  write(sb, '.specify/feature.json', JSON.stringify({ feature_directory: 'specs/001-demo' }));
  for (const n of names) write(sb, `specs/001-demo/${n}`, `# ${n}\n`);
}

export function approve(sb, runId, gate, answer = 'Approve', shape = 'input') {
  const question = `[fe-gate:${runId}:${gate}] Approve?`;
  const tool_input = {
    questions: [{ question, header: 'gate', multiSelect: false, options: [{ label: 'Approve', description: '' }, { label: 'Reject', description: '' }] }],
  };
  let tool_response = {};
  if (shape === 'input') tool_input.answers = { [question]: answer };
  if (shape === 'response-object') tool_response = { answers: { [question]: answer } };
  if (shape === 'response-text') tool_response = `User has answered your questions: "${question}"="${answer}". You can now continue.`;
  return hook(sb, 'post-tool-use', { tool_name: 'AskUserQuestion', tool_input, tool_response });
}
