// PreToolUse guard. Rules:
//   G0 router: a session whose prompt referenced Jira/Figma may not edit or run Spec Kit
//      skills until a delivery run is active in this checkout.
//   G1 Spec Kit skill ordering, derived from artifacts on disk and recorded approvals.
//   G2 human gates before product-source edits.
//   G3 risk paths must be flagged in the classification.
//   G4 diff budget of the tier.
//   G5 Bash: no nested claude, no Spec Kit workflow engine, no bypass flag, no hook-zone access.
//   G6 AskUserQuestion gate prompts must be well-formed and not pre-answered.
//   G7 shadow runs (stop after planning): no product-source edits, no implementation skills.
//   G8 guard configuration (profile, install manifest) cannot change during delivery work.
//   G9 graph first: during a run, fe-intake searches (grep/rg/find, Grep, Glob) only after the
//      run has a pilothify query; a query that exits 4 is what makes a bounded grep valid.
//   G10 the fe-reviewer starts on a graph that matches the working tree (fe graph ensure).
//   SA subagent scoping: fe-intake / fe-reviewer are read-only; fe-verifier cannot edit.
// G9/G10 follow profile graph.enforce: block denies, warn adds context and records the event,
// off does nothing. Every pilothify query/explain/path/affected during a run is recorded.
import { normalizeAgentType, relToRoot } from '../lib/context.mjs';
import { budgetExceeded } from '../lib/diff.mjs';
import { graphFreshness } from '../lib/freshness.mjs';
import { GATE_MARKER_RE } from '../lib/gates.mjs';
import { riskCategories } from '../lib/glob.mjs';
import { addContext, denyTool } from '../lib/io.mjs';
import { isArtifactPath, zones } from '../lib/paths.mjs';
import { enforceLevel } from '../lib/pilothify.mjs';
import { artifactExists, flagCategories, gatesFor, loadRun, stopAfter } from '../lib/run.mjs';
import { programOf, simpleCommands } from '../lib/shell.mjs';
import { appendEvent, readEvents, readJson, sessionMarkerFile } from '../lib/state.mjs';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GUARD_CONFIG = new Set(['.fe-delivery/profile.json', '.fe-delivery/install-manifest.json']);
const GUARD_CONFIG_RE = /\.fe-delivery(?![\w-])/;
const IMPLEMENT_SKILLS = new Set(['speckit-implement', 'speckit-converge', 'speckit-bug-fix', 'speckit-bug-test']);
const G8_REASON = 'the fe-delivery profile and install manifest are guard configuration and cannot change during delivery work; change them by hand outside a run';
const G8_BASH_REASON = 'Bash may not touch .fe-delivery paths during delivery work, except to read them (guard configuration and run state); use the fe CLI, and change the profile by hand outside a run';

// Heredoc bodies are data (for example intake JSON piped to `fe intake save -`), not commands.
export function stripHeredocs(command) {
  return String(command || '').replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<heredoc');
}
const READ_ONLY_AGENTS = new Set(['fe-intake', 'fe-reviewer']);
const NO_EDIT_AGENTS = new Set(['fe-intake', 'fe-reviewer', 'fe-verifier']);
const READ_ONLY_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'sort', 'uniq', 'jq']);
const READ_ONLY_GIT = new Set(['log', 'show', 'status', 'diff', 'rev-parse', 'ls-files', 'blame', 'branch']);
const READ_ONLY_PILOTHIFY = new Set(['query', 'explain', 'path', 'affected', 'god-nodes', '--version']);

function editTarget(input) {
  const ti = input.tool_input || {};
  return ti.file_path || ti.notebook_path || ti.path || null;
}

function deny(ctx, runId, rule, reason) {
  if (ctx && runId) appendEvent(ctx.key, runId, { type: 'deny', rule, reason });
  return denyTool(`[${rule}] ${reason}`);
}

// ---------- G5 ----------
export function bashViolation(command) {
  const cmd = String(command || '');
  if (cmd.includes('--dangerously-skip-permissions')) return 'the permission-bypass flag is not allowed';
  const hookZone = zones.hook('').replace(/\/$/, '');
  if (cmd.includes('.fe-delivery/hook') || cmd.includes(hookZone)) return 'the hook-only state directory is off limits';
  for (const simple of simpleCommands(cmd)) {
    const { program, args } = programOf(simple);
    if (program === 'claude' || program === 'claude-code' || program === '@anthropic-ai/claude-code') {
      return 'nested Claude Code sessions are not allowed during delivery';
    }
    if (program === 'specify' && args[0] === 'workflow' && ['run', 'resume'].includes(args[1])) {
      return 'the Spec Kit Workflow Engine is not used for delivery (gates would be self-approvable)';
    }
  }
  if (/\bspecify\s+workflow\s+(run|resume)\b/.test(cmd)) {
    return 'the Spec Kit Workflow Engine is not used for delivery (gates would be self-approvable)';
  }
  return null;
}

function readOnlyBashAllowed(command) {
  const parts = simpleCommands(command);
  if (parts.length === 0) return false;
  return parts.every((simple) => {
    const { program, args } = programOf(simple);
    if (!program) return false;
    if (simple.includes('>')) return false;
    if (program === 'find') return !args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a));
    if (READ_ONLY_PROGRAMS.has(program)) return true;
    if (program === 'git') return READ_ONLY_GIT.has(args[0]);
    if (program === 'pilothify') return READ_ONLY_PILOTHIFY.has(args[0]);
    return false;
  });
}

// ---------- G9 / G10: the graph ----------
const GRAPH_QUERY_SUBCOMMANDS = new Set(['query', 'explain', 'path', 'affected']);
const SEARCH_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd']);

// pilothify query/explain/path/affected calls in a Bash command (or the pilothify MCP server).
export function graphQueries(tool, command) {
  if (typeof tool === 'string' && tool.startsWith('mcp__') && /pilothify/i.test(tool)) {
    const verb = tool.split('__').pop();
    return /query|explain|path|affected|neighbo|shortest|node/i.test(verb) ? [verb] : [];
  }
  if (tool !== 'Bash') return [];
  const found = [];
  for (const simple of simpleCommands(stripHeredocs(command))) {
    const { program, args } = programOf(simple);
    if (program === 'pilothify' && GRAPH_QUERY_SUBCOMMANDS.has(args[0])) found.push(args[0]);
  }
  return found;
}

// A code search: the Grep/Glob tools, or grep/rg/find/... (and `git grep`) in Bash.
export function isCodeSearch(tool, command) {
  if (tool === 'Grep' || tool === 'Glob') return true;
  if (tool !== 'Bash') return false;
  return simpleCommands(stripHeredocs(command)).some((simple) => {
    const { program, args } = programOf(simple);
    return SEARCH_PROGRAMS.has(program) || (program === 'git' && args[0] === 'grep');
  });
}

const G9_REASON = 'query the graph first: `pilothify query "<CodeIdentifiers>" --budget 2000` or `pilothify explain "<Name>"`; '
  + 'grep only when a query returns exit 4 (no match), and record that grep as the query\'s fallback in the intake';

// Records the graph queries of a call that the guard lets through.
function recordGraphQueries(ctx, r, input, agent) {
  const queries = graphQueries(input.tool_name, input.tool_input?.command);
  if (queries.length) appendEvent(ctx.key, r.runId, { type: 'graph-query', agent: agent || 'main', via: input.tool_name, subcommands: queries });
}

function graphFirst(ctx, r, input, agent) {
  const tool = input.tool_name;
  const command = input.tool_input?.command;
  if (agent !== 'fe-intake' || !isCodeSearch(tool, command)) return null;
  // `pilothify query X || grep -rn X src` carries its own query.
  if (graphQueries(tool, command).length || readEvents(ctx.key, r.runId).some((e) => e.type === 'graph-query')) return null;
  const level = enforceLevel(ctx.profile);
  if (level === 'off') return null;
  if (level === 'block') return deny(ctx, r.runId, 'G9', G9_REASON);
  appendEvent(ctx.key, r.runId, { type: 'graph-first-skip', agent, via: tool });
  return addContext('PreToolUse', `fe-delivery [G9 warn]: ${G9_REASON}. This search ran before any graph query and is noted in the delivery report.`);
}

function subagentType(toolInput) {
  return normalizeAgentType(toolInput?.subagent_type || toolInput?.agent_type || '');
}

function reviewerGraph(ctx, r, input) {
  if (subagentType(input.tool_input) !== 'fe-reviewer') return null;
  const level = enforceLevel(ctx.profile);
  if (level === 'off') return null;
  const f = graphFreshness(ctx.key, ctx.root);
  if (f.fresh) return null;
  const why = `the pilothify graph is stale (${f.reason}), so the reviewer's \`pilothify affected\` would miss the new code; run \`fe graph ensure\` first`;
  if (level === 'block') return deny(ctx, r.runId, 'G10', why);
  appendEvent(ctx.key, r.runId, { type: 'graph-stale-review', reason: f.reason });
  return addContext('PreToolUse', `fe-delivery [G10 warn]: ${why.replace('the pilothify graph is stale', 'graph is stale')}.`);
}

// ---------- G6 ----------
function gateQuestions(toolInput) {
  return (toolInput?.questions || []).filter((q) => typeof q?.question === 'string' && q.question.includes('[fe-gate:'));
}

export function askViolation(toolInput, activeRunId) {
  const qs = gateQuestions(toolInput);
  if (qs.length === 0) return null;
  const answers = toolInput.answers && Object.keys(toolInput.answers).length > 0;
  const annotations = toolInput.annotations && Object.keys(toolInput.annotations).length > 0;
  if (answers || annotations) return 'gate questions must not carry pre-filled answers';
  for (const q of qs) {
    const m = q.question.match(GATE_MARKER_RE);
    if (!m) return 'malformed gate marker';
    if (!activeRunId || m[1] !== activeRunId) return `gate marker run "${m[1]}" is not the active run`;
    const labels = (q.options || []).map((o) => o.label).sort();
    if (labels.length !== 2 || labels[0] !== 'Approve' || labels[1] !== 'Reject') {
      return 'gate questions must offer exactly the options "Approve" and "Reject"';
    }
    if (q.multiSelect) return 'gate questions must be single-select';
  }
  return null;
}

// ---------- G1 ----------
function skillName(toolInput) {
  return String(toolInput?.skill || toolInput?.name || '').replace(/^\//, '').split(' ')[0];
}

export function skillViolation(ctx, r, skill) {
  if (!skill.startsWith('speckit-') || skill === 'speckit-constitution') return null;
  const c = r.classification;
  if (!c) return 'classify the run first (`fe classify`)';
  const isBugSkill = skill.startsWith('speckit-bug-');
  if (c.tier === 'trivial') return 'the Trivial tier does not use Spec Kit';
  if (c.tier === 'bug' && !isBugSkill) return 'a bug run uses only the speckit-bug-* skills';
  if (c.tier !== 'bug' && isBugSkill) return 'speckit-bug-* skills need a run classified as tier "bug"';
  const { missing } = gatesFor(ctx, r);
  const has = (name) => artifactExists(ctx.root, name);
  const needGate = (g) => missing.includes(g);
  switch (skill) {
    case 'speckit-specify':
      return null;
    case 'speckit-clarify':
    case 'speckit-checklist':
      return has('spec.md') ? null : 'spec.md does not exist yet (run speckit-specify)';
    case 'speckit-plan':
      if (!has('spec.md')) return 'spec.md does not exist yet (run speckit-specify)';
      return needGate('spec') ? 'the "spec" gate needs human approval first' : null;
    case 'speckit-tasks':
      if (!has('plan.md')) return 'plan.md does not exist yet (run speckit-plan)';
      return needGate('plan') ? 'the "plan" gate needs human approval first' : null;
    case 'speckit-analyze':
      return has('tasks.md') ? null : 'tasks.md does not exist yet (run speckit-tasks)';
    case 'speckit-implement': {
      if (!has('tasks.md')) return 'tasks.md does not exist yet (run speckit-tasks)';
      if (missing.length) return `gates still need human approval: ${missing.join(', ')}`;
      if ((c.blocking_questions || []).length) return 'blocking questions are unanswered';
      const over = budgetExceeded(ctx.profile, c.tier, r.diff);
      return over ? `diff budget exceeded (${over}); re-classify` : null;
    }
    case 'speckit-converge':
      return has('tasks.md') ? null : 'tasks.md does not exist yet';
    case 'speckit-bug-fix':
    case 'speckit-bug-test':
      return needGate('assessment') ? 'the "assessment" gate needs human approval first' : null;
    default:
      return null;
  }
}

// ---------- G2 / G3 / G4 ----------
export function editViolation(ctx, r, rel) {
  if (isArtifactPath(rel)) return null;
  const c = r.classification;
  if (!c) return { rule: 'G2', reason: 'classify the run before editing product source (`fe classify`)' };
  if ((c.blocking_questions || []).length) return { rule: 'G2', reason: 'blocking questions are unanswered' };
  const cats = riskCategories(ctx.profile.risk?.globs, rel);
  const flagged = new Set(flagCategories(c));
  const unflagged = cats.filter((x) => !flagged.has(x));
  if (unflagged.length) {
    return { rule: 'G3', reason: `${rel} is in risk area "${unflagged.join(', ')}" that the classification does not flag; re-classify (C3)` };
  }
  if (['small', 'medium', 'large'].includes(c.tier) && !artifactExists(ctx.root, 'tasks.md')) {
    return { rule: 'G2', reason: 'Spec Kit tiers edit source only after tasks.md exists (specify → plan → tasks first)' };
  }
  const { missing } = gatesFor(ctx, { ...r, diff: { ...(r.diff || {}), risk_hits: [...(r.diff?.risk_hits || []), ...cats.map((category) => ({ category, path: rel }))] } });
  if (missing.length) {
    return { rule: 'G2', reason: `gates need human approval before source edits: ${missing.join(', ')} (\`fe gate question <gate>\` + AskUserQuestion)` };
  }
  const over = budgetExceeded(ctx.profile, c.tier, r.diff);
  if (over) return { rule: 'G4', reason: `diff budget for tier "${c.tier}" exceeded (${over}); re-classify (C3)` };
  return null;
}

// ---------- entry ----------
export function onPreToolUse(input, ctx) {
  if (!ctx?.profile) return null;
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const agent = normalizeAgentType(input.agent_type);
  const r = ctx.activeRunId ? loadRun(ctx) : null;
  const runId = r?.runId || null;

  // Delivery work: an active run, or a prompt in this session that referenced Jira/Figma.
  const delivering = () => Boolean(r) || Boolean(readJson(sessionMarkerFile(input.session_id)));

  if (tool === 'Bash') {
    const v = bashViolation(ti.command);
    if (v) return deny(ctx, runId, 'G5', v);
    if (GUARD_CONFIG_RE.test(stripHeredocs(ti.command)) && !readOnlyBashAllowed(ti.command) && delivering()) {
      return deny(ctx, runId, 'G8', G8_BASH_REASON);
    }
    const graph = r ? graphFirst(ctx, r, input, agent) : null;
    if (denied(graph)) return graph;
    if (READ_ONLY_AGENTS.has(agent) && !readOnlyBashAllowed(ti.command)) {
      return deny(ctx, runId, 'SA', `${agent} is read-only; allowed: pilothify query/explain/path/affected/god-nodes, read-only git and file viewing`);
    }
    if (r) recordGraphQueries(ctx, r, input, agent);
    return graph;
  }

  if (tool === 'Grep' || tool === 'Glob') return r ? graphFirst(ctx, r, input, agent) : null;

  if (tool === 'Agent' || tool === 'Task') return r ? reviewerGraph(ctx, r, input) : null;

  if (EDIT_TOOLS.has(tool)) {
    if (NO_EDIT_AGENTS.has(agent)) return deny(ctx, runId, 'SA', `${agent} may not edit files`);
    const rel = relToRoot(ctx.root, editTarget(input));
    if (!rel) return null;
    if (GUARD_CONFIG.has(rel) && delivering()) return deny(ctx, runId, 'G8', G8_REASON);
    if (!r) {
      const marker = readJson(sessionMarkerFile(input.session_id));
      if (marker) return deny(ctx, null, 'G0', 'start a delivery run first (fe-deliver skill → `fe run start`)');
      return null;
    }
    const shadow = stopAfter(ctx, r);
    if (shadow.value === 'plan' && !isArtifactPath(rel)) {
      return deny(ctx, runId, 'G7', `this run stops after planning (${shadow.source}), so product source such as ${rel} may not change; write the plan and report instead`);
    }
    const v = editViolation(ctx, r, rel);
    return v ? deny(ctx, runId, v.rule, v.reason) : null;
  }

  if (tool === 'Skill') {
    const skill = skillName(ti);
    if (!skill.startsWith('speckit-')) return null;
    if (!r) {
      const marker = readJson(sessionMarkerFile(input.session_id));
      if (marker) return deny(ctx, null, 'G0', 'start a delivery run first (fe-deliver skill → `fe run start`)');
      return null;
    }
    const shadow = stopAfter(ctx, r);
    if (shadow.value === 'plan' && IMPLEMENT_SKILLS.has(skill)) {
      return deny(ctx, runId, 'G7', `${skill}: this run stops after planning (${shadow.source}); report the plan instead of implementing`);
    }
    const v = skillViolation(ctx, r, skill);
    return v ? deny(ctx, runId, 'G1', `${skill}: ${v}`) : null;
  }

  if (tool === 'AskUserQuestion') {
    const v = askViolation(ti, runId);
    return v ? deny(ctx, runId, 'G6', v) : null;
  }

  if (typeof tool === 'string' && tool.startsWith('mcp__') && NO_EDIT_AGENTS.has(agent) && isMcpWrite(tool)) {
    return deny(ctx, runId, 'SA', `${agent} may not call write tools (${tool})`);
  }
  if (r && typeof tool === 'string' && tool.startsWith('mcp__')) recordGraphQueries(ctx, r, input, agent);
  return null;
}

function denied(out) {
  return out?.hookSpecificOutput?.permissionDecision === 'deny';
}

const MCP_WRITE_VERB = /^(create|edit|update|transition|add|delete|remove|assign|move|set|send|upload|use_figma|generate|post|put|patch|merge|publish|write)/i;

export function isMcpWrite(toolName) {
  const parts = String(toolName).split('__');
  return MCP_WRITE_VERB.test(parts[parts.length - 1] || '');
}
