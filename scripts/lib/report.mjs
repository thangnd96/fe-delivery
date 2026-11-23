// Deterministic delivery report built from the run ledger (ARCHITECTURE §11).
import { graphFreshness, short } from './freshness.mjs';
import { enforceLevel } from './pilothify.mjs';
import { endConditions, gatesFor, stopAfter } from './run.mjs';
import { readEvents } from './state.mjs';

// The run's graph use: refreshes (from the fe CLI), queries and early searches (seen by the
// PreToolUse hook), the intake's own query list, and whether the graph matches the tree now.
export function graphSummary(ctx, r, events = readEvents(ctx.key, r.runId)) {
  const refreshes = r.graph?.refreshes || [];
  const count = (pred) => refreshes.filter(pred).length;
  const queries = Array.isArray(r.intake?.codebase?.queries) ? r.intake.codebase.queries : [];
  const byExit = { 0: 0, 3: 0, 4: 0 };
  for (const q of queries) if (q.exit_code in byExit) byExit[q.exit_code] += 1;
  const f = graphFreshness(ctx.key, ctx.root);
  return {
    enforce: enforceLevel(ctx.profile),
    refreshes: refreshes.length,
    full: count((x) => x.ok && x.mode === 'full'),
    incremental: count((x) => x.ok && x.mode === 'incremental'),
    unchanged: count((x) => x.ok && x.mode === 'unchanged'),
    failed: count((x) => !x.ok),
    last: refreshes[refreshes.length - 1] || null,
    fresh: f.fresh,
    reason: f.reason,
    head: f.current.head,
    dirty_paths: f.current.dirty_paths,
    intake_queries: queries.length,
    intake_by_exit: byExit,
    grep_fallbacks: queries.filter((q) => q.fallback).length,
    queries_seen: events.filter((e) => e.type === 'graph-query').length,
    searches_before_query: events.filter((e) => e.type === 'graph-first-skip').length,
    warnings: (r.graph?.warnings || []).map((w) => `${w.checkpoint}: ${w.message}`),
  };
}

function graphLines(g) {
  const out = [];
  if (g.enforce === 'off') {
    out.push('- graph.enforce = off: fe-delivery did not refresh or check the graph in this run.');
    return out;
  }
  out.push(`- Refreshes: ${g.refreshes} (full ${g.full}, incremental ${g.incremental}, unchanged ${g.unchanged}, failed ${g.failed})${g.last ? `; last: ${g.last.checkpoint} at ${g.last.at}` : ''}`);
  const tree = `HEAD ${short(g.head)}${g.dirty_paths ? ` + ${g.dirty_paths} uncommitted path(s)` : ''}`;
  out.push(`- Graph vs working tree: ${g.fresh ? `fresh (${tree})` : `STALE (${g.reason}; ${tree})`}`);
  out.push(`- Intake queries: ${g.intake_queries} (exit 0: ${g.intake_by_exit[0]}, exit 3: ${g.intake_by_exit[3]}, exit 4: ${g.intake_by_exit[4]}); grep fallback: ${g.grep_fallbacks ? `yes (${g.grep_fallbacks})` : 'no'}`);
  out.push(`- Queries run in this run (seen by hooks): ${g.queries_seen}${g.searches_before_query ? `; intake searches before any query: ${g.searches_before_query}` : ''}`);
  for (const w of g.warnings) out.push(`- Warning: ${w}`);
  out.push(`- graph.enforce: ${g.enforce}`);
  return out;
}

function table(headers, rows) {
  if (rows.length === 0) return '_none_\n';
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n') + '\n';
}

export function buildReport(ctx, r) {
  const run = r.run || {};
  const c = r.classification;
  const diff = r.diff || { files: [], total_files: 0, total_loc: 0 };
  const missing = endConditions(ctx, r, { ignoreReport: true });
  const gates = gatesFor(ctx, r);
  const events = readEvents(ctx.key, r.runId);
  const denies = events.filter((e) => e.type === 'deny');
  const out = [];
  out.push(`# Delivery report — ${r.runId}`);
  out.push('');
  const shadow = stopAfter(ctx, r);
  const done = shadow.value === 'plan' ? 'PLANNED (shadow run, no product-source changes)' : 'READY FOR REVIEW';
  out.push(`**Status:** ${missing.length ? 'INCOMPLETE' : done}`);
  if (shadow.value === 'plan') out.push(`**Mode:** shadow — stops after planning (${shadow.source}).`);
  if (ctx.profileChanged) out.push('**Note:** the profile on disk changed during the run; the run was held to the profile frozen at its start.');
  if (missing.length) out.push('', '**Missing:**', ...missing.map((m) => `- ${m}`));
  out.push('', '## Sources');
  out.push(`- Jira: ${(run.jira_keys || []).join(', ') || 'none'}`);
  out.push(`- Figma: ${(run.figma_urls || []).join(' ') || 'none'}`);
  out.push(`- Checkout:\`${run.worktree || ctx.root}\` · branch \`${run.branch || '?'}\` · base \`${(r.state?.base_sha || '').slice(0, 12)}\``);
  out.push('', '## Classification');
  if (c) {
    out.push(`- Task type: ${c.task_type}; tier **${c.tier}** (model ${c.model_tier || '?'}, floor ${c.tier_floor})`);
    out.push(`- Risk flags: ${(c.risk_flags || []).map((f) => `${f.category} (${f.source})`).join(', ') || 'none'}`);
    if (c.blast_radius) {
      out.push(`- Blast radius (EXTRACTED edges, depth ${c.blast_radius.depth}): ${c.blast_radius.dependent_files} dependent files; packages ${(c.blast_radius.packages || []).join(', ') || '-'}`);
    }
    out.push(`- Predicted files: ${(c.predicted_files || []).length}; actual changed files: ${diff.total_files}`);
    if (c.override?.requested_tier) out.push(`- Override: ${c.override.requested_tier} — ${c.override.reason || ''}`);
  } else {
    out.push('- not classified');
  }
  out.push('', '## Gates');
  out.push(table(['gate', 'status'], gates.required.map((g) => [g, gates.missing.includes(g) ? 'MISSING approval' : 'approved'])));
  out.push('## Changes');
  out.push(`${diff.total_files} files, ${diff.total_loc} changed lines${diff.ui_changed ? ', UI files touched' : ''}.`);
  out.push('');
  out.push(table(['file', '+', '-'], (diff.files || []).map((f) => [f.path, f.added, f.removed])));
  if ((diff.risk_hits || []).length || (diff.content_hits || []).length) {
    out.push('Risk areas touched:');
    for (const h of diff.risk_hits || []) out.push(`- ${h.category}: ${h.path}`);
    for (const h of diff.content_hits || []) out.push(`- content "${h.pattern}": ${h.path}`);
    out.push('');
  }
  out.push('## Evidence (measured by scripts)');
  out.push(table(['level', 'kind', 'command', 'exit', 'status', 'sha', 'finished'],
    r.evidence.map((e) => [e.level, e.kind, e.command, e.exit_code, e.status, (e.git_sha || '').slice(0, 10), e.finished_at])));
  out.push('## UI / visual checks (reported by the agent)');
  out.push(table(['level', 'kind', 'status', 'viewport', 'reason', 'artifacts'],
    r.claims.map((x) => [x.level, x.kind, x.status, x.viewport, x.reason, (x.artifacts || []).join(' ')])));
  out.push('## Intake notes');
  const intake = r.intake || {};
  const openQ = (intake.open_questions || []).map((q) => `${q.blocking ? '[blocking] ' : ''}${q.question}`);
  out.push(`- Open questions: ${openQ.join(' · ') || 'none'}`);
  out.push(`- Conflicts: ${(intake.conflicts || []).map((x) => `${x.material ? '[material] ' : ''}${x.description}`).join(' · ') || 'none'}`);
  out.push(`- Instructions found in sources and NOT followed: ${(intake.instructions_found_not_followed || []).map((x) => `${x.source}: "${x.excerpt}"`).join(' · ') || 'none'}`);
  out.push('', '## Graph');
  out.push(...graphLines(graphSummary(ctx, r, events)));
  out.push('', '## Guard events');
  out.push(denies.length ? denies.map((d) => `- ${d.at} ${d.reason}`).join('\n') : '_none_');
  out.push('', '## External writes');
  out.push('fe-delivery performed none. Pushes, MRs and Jira/Figma writes go through Claude Code ask prompts and are listed by the agent below if the user approved any.');
  out.push('');
  return out.join('\n');
}
