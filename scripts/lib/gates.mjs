// Which human gates a run needs, and which are approved. Approvals are written only by
// the PostToolUse hook from AskUserQuestion answers, so the model cannot create them.
import { readJson } from './state.mjs';

export const GATE_IDS = ['spec', 'plan', 'override', 'assessment'];
export const TIER_ORDER = ['trivial', 'small', 'medium', 'large'];

export function requiredGates({ tier, flags = [], observedRisk = [], belowFloor = false }) {
  const gates = new Set();
  const risky = flags.length > 0 || observedRisk.length > 0;
  if (tier === 'large') {
    gates.add('spec');
    gates.add('plan');
  } else if (tier === 'medium') {
    gates.add('plan');
  } else if (tier === 'bug') {
    if (risky) gates.add('assessment');
  } else if (risky) {
    gates.add('plan');
  }
  if (belowFloor) gates.add('override');
  return [...gates];
}

export function approvedGates(approvalsFile) {
  const latest = {};
  for (const a of readJson(approvalsFile, [])) latest[a.gate] = a.decision;
  return Object.entries(latest)
    .filter(([, d]) => d === 'approve')
    .map(([g]) => g);
}

export function missingGates(required, approvalsFile) {
  const ok = new Set(approvedGates(approvalsFile));
  return required.filter((g) => !ok.has(g));
}

export function tierRank(tier) {
  return TIER_ORDER.indexOf(tier);
}

export function maxTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}

// Gate prompts carry this marker so the PostToolUse hook can recognise them.
export function gateMarker(runId, gate) {
  return `[fe-gate:${runId}:${gate}]`;
}

export const GATE_MARKER_RE = /\[fe-gate:([A-Za-z0-9._-]+):(spec|plan|override|assessment)\]/;
