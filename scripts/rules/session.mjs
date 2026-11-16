// S1/S2 — SessionStart: tell Claude how to call the fe CLI, report the active run, and
// surface cached version / graph-freshness notices. Refreshes the cache in the background.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../lib/graph.mjs';
import { head } from '../lib/git.mjs';
import { addContext } from '../lib/io.mjs';
import { atlassianReminder, atlassianV1InProject } from '../lib/mcp.mjs';
import { feCliPath, pluginRoot, zones } from '../lib/paths.mjs';
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
    'Jira/Figma/implementation requests go through the fe-deliver skill; each run works in its own worktree.',
  ];
  if (ctx.profileErrors.length) lines.push(`Profile problems: ${ctx.profileErrors.join('; ')}`);
  if (ctx.profile?.rollout?.mode === 'shadow') {
    lines.push('Shadow mode (profile rollout.mode = shadow): delivery runs stop after planning — classify, spec, plan, tasks, report. No product-source edits, no speckit-implement.');
  }
  const r = ctx.profile ? loadRun(ctx) : null;
  if (r) lines.push(`Active run in this worktree: ${r.runId} (tier ${r.classification?.tier || 'unclassified'}).`);
  if (r && ctx.profileChanged) lines.push('The profile on disk changed after this run started; the run keeps the profile frozen at its start.');
  const cache = readJson(cacheFile());
  const stale = !cache || Date.now() - Date.parse(cache.at || 0) > CACHE_TTL_MS;
  if (stale && !process.env.FE_DELIVERY_NO_REFRESH) refreshInBackground();
  lines.push(...versionNotices(cache, ctx.profile, compat(), process.env.FE_DELIVERY_MAINTAINER === '1'));
  if (atlassianV1InProject(ctx.root)) lines.push(atlassianReminder());
  const graph = existsSync(join(ctx.root, 'pilothify-out', 'graph.json')) ? loadGraphHeader(ctx.root) : null;
  if (!graph) lines.push(`No pilothify graph yet. Build it: node "${feCliPath()}" graph ensure`);
  else if (graph.built_at_commit && graph.built_at_commit !== head(ctx.root)) {
    lines.push(`pilothify graph is behind HEAD. Refresh: node "${feCliPath()}" graph ensure`);
  }
  return addContext('SessionStart', lines.join('\n'));
}

// Reads only the first and last 64 KiB of a (possibly very large) graph.json to find
// built_at_commit without parsing the whole file. Small graphs are parsed normally.
function loadGraphHeader(root) {
  const file = join(root, 'pilothify-out', 'graph.json');
  try {
    const size = statSync(file).size;
    if (size <= 256 * 1024) {
      const g = loadGraph(root);
      return g ? { built_at_commit: g.built_at_commit || null } : null;
    }
    const fd = openSync(file, 'r');
    const chunk = 64 * 1024;
    const headBuf = Buffer.alloc(chunk);
    const tailBuf = Buffer.alloc(chunk);
    readSync(fd, headBuf, 0, chunk, 0);
    readSync(fd, tailBuf, 0, chunk, size - chunk);
    closeSync(fd);
    const text = headBuf.toString('utf8') + tailBuf.toString('utf8');
    const m = text.match(/"built_at_commit"\s*:\s*"([0-9a-f]{7,40})"/);
    return { built_at_commit: m ? m[1] : null };
  } catch {
    return null;
  }
}
