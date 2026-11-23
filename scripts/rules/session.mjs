// S1/S2 — SessionStart: tell Claude how to call the fe CLI, report the active run, and
// surface cached version / graph-freshness notices. Refreshes the cache in the background.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { graphFreshness, isLinkedWorktree } from '../lib/freshness.mjs';
import { legacyWorktreeLine, legacyWorktreeNotice } from '../lib/install.mjs';
import { addContext } from '../lib/io.mjs';
import { atlassianReminder, atlassianV1InProject } from '../lib/mcp.mjs';
import { feCliPath, pluginRoot, zones } from '../lib/paths.mjs';
import { enforceLevel, gitHooksState } from '../lib/pilothify.mjs';
import { loadRun } from '../lib/run.mjs';
import { compare, satisfies } from '../lib/semver.mjs';
import { readJson } from '../lib/state.mjs';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheFile() {
  return join(zones.cache(), 'versions.json');
}

export function compat() {
  return readJson(join(pluginRoot(), 'compat', 'speckit.json'), {});
}

export function versionNotices(cache, profile, comp, maintainer = false) {
  const notes = [];
  const sk = comp.speckit || {};
  const pf = comp.pilothify || {};
  if (!cache) return notes;
  if (!cache.speckit) notes.push(`Spec Kit CLI not found. Install: ${sk.install || 'uv tool install specify-cli'}`);
  else if (sk.range && !satisfies(cache.speckit, sk.range)) {
    notes.push(`Spec Kit ${cache.speckit} is outside the range fe-delivery supports (${sk.range}).`);
  }
  const pin = profile?.versions?.speckit;
  if (pin && sk.tested && compare(pin, sk.tested) < 0) {
    notes.push(`This repo pins Spec Kit ${pin}; fe-delivery is tested with ${sk.tested}. Run /fe-delivery:speckit-upgrade.`);
  }
  if (!cache.pilothify) notes.push(`pilothify CLI not found. Install: ${pf.install || 'see compat/speckit.json'}`);
  else if (pf.min && compare(cache.pilothify, pf.min) < 0) {
    notes.push(`pilothify ${cache.pilothify} is older than ${pf.min}. Install: ${pf.install}`);
  }
  if (maintainer && cache.speckit_latest && sk.tested && compare(cache.speckit_latest, sk.tested) > 0) {
    notes.push(`Maintainer: Spec Kit ${cache.speckit_latest} is released; fe-delivery tested ${sk.tested}. Run the speckit-update workflow.`);
  }
  return notes;
}

function refreshInBackground() {
  try {
    const child = spawn(process.execPath, [join(pluginRoot(), 'scripts', 'hook.mjs'), 'refresh-versions'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    // fail-open
  }
}

export function onSessionStart(input, ctx) {
  if (!ctx) return null;
  const lines = [
    `fe-delivery is enabled in this repository. CLI: node "${feCliPath()}" <command> (run \`help\` for the list).`,
    'Jira/Figma/implementation requests go through the fe-deliver skill; runs work in the current checkout, and a worktree is made only when the user asks for one.',
  ];
  if (legacyWorktreeLine(ctx.root)) lines.push(legacyWorktreeNotice());
  if (ctx.profileErrors.length) lines.push(`Profile problems: ${ctx.profileErrors.join('; ')}`);
  if (ctx.profile?.rollout?.mode === 'shadow') {
    lines.push('Shadow mode (profile rollout.mode = shadow): delivery runs stop after planning — classify, spec, plan, tasks, report. No product-source edits, no speckit-implement.');
  }
  const r = ctx.profile ? loadRun(ctx) : null;
  if (r) lines.push(`Active run in this checkout: ${r.runId} (tier ${r.classification?.tier || 'unclassified'}).`);
  if (r && ctx.profileChanged) lines.push('The profile on disk changed after this run started; the run keeps the profile frozen at its start.');
  const cache = readJson(cacheFile());
  const stale = !cache || Date.now() - Date.parse(cache.at || 0) > CACHE_TTL_MS;
  if (stale && !process.env.FE_DELIVERY_NO_REFRESH) refreshInBackground();
  lines.push(...versionNotices(cache, ctx.profile, compat(), process.env.FE_DELIVERY_MAINTAINER === '1'));
  if (atlassianV1InProject(ctx.root)) lines.push(atlassianReminder());
  lines.push(...graphNotices(ctx));
  return addContext('SessionStart', lines.join('\n'));
}

// Graph freshness is judged against fe's stamp ({ head, fingerprint } of the last refresh),
// so a branch switch, a pull or an uncommitted edit all count. A graph without
// built_at_commit, or without a stamp, is never assumed fresh.
export function graphNotices(ctx) {
  const lines = [];
  const fe = `node "${feCliPath()}"`;
  const f = graphFreshness(ctx.key, ctx.root);
  if (!f.graph) lines.push(`No pilothify graph yet. Build it: ${fe} graph ensure`);
  else if (!f.fresh) {
    lines.push(`The pilothify graph may not match the code (${f.reason}). Refresh: ${fe} graph ensure (a run start rebuilds it in full).`);
  }
  if (enforceLevel(ctx.profile) === 'off') return lines;
  if (isLinkedWorktree(ctx.root)) {
    lines.push('This checkout is a linked worktree: pilothify\'s git hooks skip rebuilds here, so fe refreshes the graph itself at run start and at its checkpoints.');
  } else {
    const hooks = gitHooksState(ctx);
    if (hooks.wanted && !hooks.any) {
      lines.push(`pilothify git hooks are not installed in this clone, so commits, branch switches and pulls do not refresh the graph. Ask the user to run, outside the sandbox: ! ${fe} git-hooks install`);
    }
  }
  return lines;
}
