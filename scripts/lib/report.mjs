// Deterministic delivery report built from the run ledger (ARCHITECTURE §11).
import { endConditions, gatesFor } from './run.mjs';
import { readEvents } from './state.mjs';

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
  out.push(`**Status:** ${missing.length ? 'INCOMPLETE' : 'READY FOR REVIEW'}`);
  if (missing.length) out.push('', '**Missing:**', ...missing.map((m) => `- ${m}`));
  out.push('', '## Sources');
  out.push(`- Jira: ${(run.jira_keys || []).join(', ') || 'none'}`);
  out.push(`- Figma: ${(run.figma_urls || []).join(' ') || 'none'}`);
  out.push(`- Worktree: \`${run.worktree || ctx.root}\` · branch \`${run.branch || '?'}\` · base \`${(r.state?.base_sha || '').slice(0, 12)}\``);
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
  out.push('', '## Guard events');
  out.push(denies.length ? denies.map((d) => `- ${d.at} ${d.reason}`).join('\n') : '_none_');
  out.push('', '## External writes');
  out.push('fe-delivery performed none. Pushes, MRs and Jira/Figma writes go through Claude Code ask prompts and are listed by the agent below if the user approved any.');
  out.push('');
  return out.join('\n');
}
