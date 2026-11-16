// Run-level helpers shared by hooks and the fe CLI.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { budgetExceeded, computeDiff, observedRiskCategories } from './diff.mjs';
import { missingGates, requiredGates } from './gates.mjs';
import { head, statusPaths } from './git.mjs';
import { agentFiles, hookFiles, mtimeMs, readJson, writeJson } from './state.mjs';

export function loadRun(ctx, runId = ctx.activeRunId) {
  if (!runId) return null;
  const a = agentFiles(ctx.key, runId);
  const h = hookFiles(ctx.key, runId);
  return {
    runId,
    a,
    h,
    run: readJson(a.run),
    intake: readJson(a.intake),
    classification: readJson(a.classification),
    claims: readJson(a.claims, []),
    state: readJson(h.state),
    diff: readJson(h.diff),
    evidence: readJson(h.evidence, []),
    approvals: readJson(h.approvals, []),
  };
}

export function initHookState(ctx, runId, sessionId) {
  const h = hookFiles(ctx.key, runId);
  const state = {
    run_id: runId,
    worktree: ctx.root,
    base_sha: head(ctx.root),
    initial_dirty: statusPaths(ctx.root),
    started_at: new Date().toISOString(),
    session_id: sessionId || null,
  };
  writeJson(h.state, state);
  return state;
}

export function refreshDiff(ctx, runId) {
  const h = hookFiles(ctx.key, runId);
  const state = readJson(h.state);
  if (!state?.base_sha) return null;
  const diff = computeDiff(ctx.root, state.base_sha, ctx.profile, state.initial_dirty || []);
  const prev = readJson(h.diff);
  const changed = !prev || prev.fingerprint !== diff.fingerprint;
  diff.last_edit_at = changed ? new Date().toISOString() : prev.last_edit_at;
  writeJson(h.diff, diff);
  return diff;
}

export function featureDir(root) {
  const fj = readJson(join(root, '.specify', 'feature.json'));
  const dir = fj?.feature_directory;
  if (!dir) return null;
  return isAbsolute(dir) ? dir : join(root, dir);
}

export function artifactExists(root, name) {
  const dir = featureDir(root);
  return Boolean(dir && existsSync(join(dir, name)));
}

export function flagCategories(classification) {
  return (classification?.risk_flags || []).map((f) => f.category);
}

export function gatesFor(ctx, r) {
  const c = r.classification;
  if (!c) return { required: [], missing: [] };
  const observed = observedRiskCategories(r.diff);
  const required = requiredGates({
    tier: c.tier,
    flags: flagCategories(c),
    observedRisk: observed,
    belowFloor: Boolean(c.override?.below_floor),
  });
  return { required, missing: missingGates(required, r.h.approvals) };
}

const after = (iso, ref) => Boolean(iso) && Date.parse(iso) >= Date.parse(ref);

// Everything that must hold before a run with changes may end (Stop gate and `fe run end`).
export function endConditions(ctx, r, { ignoreReport = false } = {}) {
  const missing = [];
  const diff = r.diff;
  if (!diff || diff.total_files === 0) return missing;
  const lastEdit = diff.last_edit_at;
  if (!r.classification) missing.push('classification (run `fe classify`)');
  const { missing: gates } = gatesFor(ctx, r);
  for (const g of gates) missing.push(`human approval for gate "${g}"`);
  const checks = ctx.profile?.checks || {};
  const required = [];
  for (const kind of ['typecheck', 'lint', 'build', 'test']) if (checks[kind]) required.push(kind);
  for (const kind of required) {
    const ok = r.evidence.some((e) => e.kind === kind && after(e.finished_at, lastEdit));
    if (!ok) missing.push(`fresh evidence for "${kind}" (run \`fe verify\`)`);
  }
  if (diff.ui_changed) {
    const ok = r.claims.some((c) => c.level === 'L2' && after(c.at, lastEdit));
    if (!ok) missing.push('L2 UI check result (`fe evidence add --level L2 ...`, or not_verified with a reason)');
  }
  const budget = budgetExceeded(ctx.profile, r.classification?.tier, diff);
  if (budget) missing.push(`re-classification (diff budget exceeded: ${budget})`);
  if (!ignoreReport && mtimeMs(r.a.report) < Date.parse(lastEdit)) {
    missing.push('delivery report newer than the last edit (run `fe report`)');
  }
  return missing;
}

export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
