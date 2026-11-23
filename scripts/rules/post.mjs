// PostToolUse recorder. Rules:
//   P1 AskUserQuestion gate answers → approvals (hook zone). Only the exact option
//      "Approve" approves; "Reject" rejects; anything else is ignored.
//   P2 Edit/Write/Bash → recompute diff facts from git (last_edit_at moves only when files change).
//   P3 fe CLI trailers (only from an exact fe CLI command): RUN_STARTED registers the run,
//      EVIDENCE records measured checks, RUN_END_REQUEST ends the run if end conditions hold.
//   P4 a git command that changes the working tree (checkout, switch, pull, merge, rebase,
//      reset, stash, restore, cherry-pick, revert) starts a background `pilothify update`.
//      pilothify's own git hooks cover some of these, not stash/reset/restore, and none run in
//      a linked worktree; the update waits on pilothify's lock, so a hook rebuild is not doubled
//      into a race. fe's checkpoints wait for it before they read the graph.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { graphFile } from '../lib/freshness.mjs';
import { GATE_MARKER_RE } from '../lib/gates.mjs';
import { addContext, block } from '../lib/io.mjs';
import { pluginRoot } from '../lib/paths.mjs';
import { enforceLevel } from '../lib/pilothify.mjs';
import { endConditions, initHookState, loadRun, refreshDiff } from '../lib/run.mjs';
import { validate, loadSchema } from '../lib/schema.mjs';
import { programOf, simpleCommands } from '../lib/shell.mjs';
import {
  agentFiles, appendEvent, clearActiveRun, exists, getActiveRunId, hookFiles, readJson, sessionMarkerFile, setActiveRun, writeJson,
} from '../lib/state.mjs';
import { bashStdout, isFeCliCommand, parseTrailers } from '../lib/trailers.mjs';
import { EDIT_TOOLS, stripHeredocs } from './pre.mjs';

const TREE_CHANGING_GIT = new Set(['checkout', 'switch', 'pull', 'merge', 'rebase', 'reset', 'stash', 'restore', 'cherry-pick', 'revert']);
const READ_ONLY_STASH = new Set(['list', 'show']);
// git's global options that take a value as the next word.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (GIT_OPTS_WITH_VALUE.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    return { sub: a, rest: args.slice(i + 1) };
  }
  return { sub: null, rest: [] };
}

// The first git subcommand in `command` that can change the working tree, or null.
export function treeChangingGit(command) {
  for (const simple of simpleCommands(stripHeredocs(command))) {
    const { program, args } = programOf(simple);
    if (program !== 'git') continue;
    const { sub, rest } = gitSubcommand(args);
    if (!TREE_CHANGING_GIT.has(sub)) continue;
    if (sub === 'stash' && READ_ONLY_STASH.has(rest[0])) continue;
    return sub;
  }
  return null;
}

function refreshInBackground(ctx) {
  try {
    const child = spawn(process.execPath, [join(pluginRoot(), 'scripts', 'graph-refresh.mjs'), ctx.root], {
      cwd: ctx.root,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function afterGitCommand(input, ctx) {
  const sub = treeChangingGit(input.tool_input?.command);
  if (!sub || enforceLevel(ctx.profile) === 'off' || !existsSync(graphFile(ctx.root))) return null;
  if (!refreshInBackground(ctx)) return null;
  if (ctx.activeRunId) appendEvent(ctx.key, ctx.activeRunId, { type: 'graph-refresh-started', after: `git ${sub}` });
  return addContext(
    'PostToolUse',
    `fe-delivery: \`git ${sub}\` changed the working tree, so the pilothify graph is refreshing in the background. `
      + '`fe graph ensure` and the fe checkpoints wait for it; query the graph after that.',
  );
}

function answerFor(input, question) {
  const fromInput = input.tool_input?.answers?.[question];
  if (typeof fromInput === 'string') return fromInput;
  const resp = input.tool_response;
  if (resp && typeof resp === 'object' && resp.answers && typeof resp.answers[question] === 'string') {
    return resp.answers[question];
  }
  const text = typeof resp === 'string' ? resp : JSON.stringify(resp ?? '');
  const marker = question.match(GATE_MARKER_RE)?.[0];
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === question || (marker && m[1].includes(marker))) return m[2];
  }
  return null;
}

export function recordGateAnswers(input, ctx) {
  const runId = ctx.activeRunId;
  if (!runId) return [];
  const recorded = [];
  for (const q of input.tool_input?.questions || []) {
    const m = typeof q?.question === 'string' ? q.question.match(GATE_MARKER_RE) : null;
    if (!m || m[1] !== runId) continue;
    const answer = answerFor(input, q.question);
    const decision = answer === 'Approve' ? 'approve' : answer === 'Reject' ? 'reject' : null;
    if (!decision) {
      appendEvent(ctx.key, runId, { type: 'gate-answer-ignored', gate: m[2], answer });
      continue;
    }
    const file = hookFiles(ctx.key, runId).approvals;
    const list = readJson(file, []);
    const entry = {
      gate: m[2],
      decision,
      at: new Date().toISOString(),
      question_sha256: createHash('sha256').update(q.question).digest('hex'),
      session_id: input.session_id || null,
    };
    list.push(entry);
    writeJson(file, list);
    appendEvent(ctx.key, runId, { type: 'gate', gate: m[2], decision });
    recorded.push(entry);
  }
  return recorded;
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function handleTrailers(input, ctx) {
  const command = input.tool_input?.command;
  if (!isFeCliCommand(command, ['run start', 'run end', 'verify'])) return null;
  let feedback = null;
  const evidenceItemSchema = loadSchema('evidence').properties.items.items;
  for (const { kind, data } of parseTrailers(bashStdout(input.tool_response))) {
    if (kind === 'RUN_STARTED') {
      if (!data?.run_id || !samePath(data.worktree, ctx.root)) continue;
      if (!exists(agentFiles(ctx.key, data.run_id).run)) continue;
      const current = getActiveRunId(ctx.key, ctx.root);
      if (current && current !== data.run_id) {
        appendEvent(ctx.key, current, { type: 'run-start-refused', other: data.run_id });
        feedback = block(`run ${current} is still active in this checkout; end it first (\`fe run end\`)`);
        continue;
      }
      // A shadow run comes from the user's [stop-after:plan] (recorded by the prompt hook) or
      // from the run start flag; the model can add this restriction but never remove it.
      const fromPrompt = readJson(sessionMarkerFile(input.session_id))?.stop_after === 'plan';
      const fromFlag = data.stop_after === 'plan';
      setActiveRun(ctx.key, ctx.root, data.run_id);
      ctx.activeRunId = data.run_id;
      initHookState(ctx, data.run_id, input.session_id, {
        stop_after: fromPrompt || fromFlag ? 'plan' : null,
        stop_after_source: fromPrompt ? 'user prompt [stop-after:plan]' : fromFlag ? 'fe run start --stop-after plan' : null,
      });
      appendEvent(ctx.key, data.run_id, { type: 'run-started' });
    } else if (kind === 'EVIDENCE') {
      const runId = ctx.activeRunId;
      if (!runId || data?.run_id !== runId) continue;
      const item = { ...data };
      delete item.run_id;
      const errors = validate(evidenceItemSchema, item);
      const expected = ctx.profile?.checks?.[item.kind];
      if (expected && item.command !== expected) {
        errors.push(`command "${item.command}" is not the profile's ${item.kind} check "${expected}" (frozen at run start)`);
      }
      if (errors.length) {
        appendEvent(ctx.key, runId, { type: 'evidence-rejected', errors });
        continue;
      }
      const file = hookFiles(ctx.key, runId).evidence;
      const list = readJson(file, []);
      list.push(item);
      writeJson(file, list);
    } else if (kind === 'RUN_END_REQUEST') {
      const runId = ctx.activeRunId;
      if (!runId || data?.run_id !== runId) continue;
      refreshDiff(ctx, runId);
      const missing = endConditions(ctx, loadRun(ctx, runId));
      if (missing.length) {
        appendEvent(ctx.key, runId, { type: 'run-end-refused', missing });
        feedback = block(`run ${runId} cannot end yet; missing: ${missing.join('; ')}`);
      } else {
        clearActiveRun(ctx.key, ctx.root);
        appendEvent(ctx.key, runId, { type: 'run-ended' });
      }
    }
  }
  return feedback;
}

export function onPostToolUse(input, ctx) {
  if (!ctx?.profile) return null;
  const tool = input.tool_name;
  if (tool === 'AskUserQuestion') {
    recordGateAnswers(input, ctx);
    return null;
  }
  let feedback = null;
  if (tool === 'Bash') feedback = handleTrailers(input, ctx);
  if ((tool === 'Bash' || EDIT_TOOLS.has(tool)) && ctx.activeRunId) refreshDiff(ctx, ctx.activeRunId);
  if (tool === 'Bash' && !feedback) feedback = afterGitCommand(input, ctx);
  return feedback;
}
