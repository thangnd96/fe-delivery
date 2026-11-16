// T1 — Stop: when the active run has changes and end conditions are missing, block once per
// edit epoch (diff fingerprint) so Claude either finishes verification or says plainly that
// the run is still in progress. Never blocks twice in a row (stop_hook_active).
import { block } from '../lib/io.mjs';
import { endConditions, loadRun, refreshDiff } from '../lib/run.mjs';
import { appendEvent, readJson, writeJson } from '../lib/state.mjs';

export function onStop(input, ctx) {
  if (!ctx?.profile || !ctx.activeRunId) return null;
  const runId = ctx.activeRunId;
  const diff = refreshDiff(ctx, runId);
  if (!diff || diff.total_files === 0) return null;
  const r = loadRun(ctx, runId);
  const missing = endConditions(ctx, r);
  if (missing.length === 0) return null;
  if (input.stop_hook_active) {
    appendEvent(ctx.key, runId, { type: 'stop-with-missing', missing });
    return null;
  }
  const state = readJson(r.h.state, {});
  if (state.last_stop_block === diff.fingerprint) return null;
  writeJson(r.h.state, { ...state, last_stop_block: diff.fingerprint });
  appendEvent(ctx.key, runId, { type: 'stop-blocked', missing });
  return block(
    `run ${runId} has changes but is not deliverable yet. Missing: ${missing.join('; ')}. `
      + 'Either complete these (fe verify, fe evidence add, fe report), or tell the user clearly that the run is still in progress and what remains.',
  );
}
