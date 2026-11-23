// Refreshing the pilothify graph (0 LLM tokens) and the run's graph log.
//   ensureGraph   waits for pilothify's rebuild lock, then runs `update`, `update --full` or
//                 the first `extract --code-only`, and records { head, fingerprint, mode, at,
//                 exit, nodes } in the checkout stamp and in the run. A refused write is a failure.
//   git hooks     `pilothify hook install --no-merge-driver` per clone, recorded so that
//                 fe-delivery only ever removes hooks it installed itself.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { relative } from 'node:path';
import {
  gitHooksRecordFile, graphFile, graphFreshness, isLinkedWorktree, outDirName, pilothifyHooks, short, waitForRebuildLock,
  worktreeStamp, writeStamp,
} from './freshness.mjs';
import { agentFiles, readJson, writeJson } from './state.mjs';

export const ENFORCE_LEVELS = ['off', 'warn', 'block'];

// profile.graph.enforce: off | warn | block. Absent means warn (like rollout.mode → full).
export function enforceLevel(profile) {
  const v = profile?.graph?.enforce;
  return ENFORCE_LEVELS.includes(v) ? v : 'warn';
}

export function runPilothify(root, args) {
  const res = spawnSync('pilothify', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PILOTHIFY_BACKEND: 'none' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, error: res.error || null, stdout: res.stdout || '', stderr: res.stderr || '' };
}

export function pilothifyVersion() {
  const res = spawnSync('pilothify', ['--version'], { encoding: 'utf8' });
  if (res.error) return null;
  return (`${res.stdout}${res.stderr}`.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
}

function lastLines(text, n) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-n).join(' | ');
}

export function graphCounts(root) {
  try {
    const g = JSON.parse(readFileSync(graphFile(root), 'utf8'));
    return { nodes: (g.nodes || []).length, edges: (g.links || g.edges || []).length, built_at_commit: g.built_at_commit || null };
  } catch {
    return { nodes: null, edges: null, built_at_commit: null };
  }
}

// ---------- the run's graph log (agent zone) ----------
export function readGraphLog(key, runId) {
  const log = readJson(agentFiles(key, runId).graph, null);
  return { refreshes: log?.refreshes || [], warnings: log?.warnings || [] };
}

function writeGraphLog(key, runId, mutate) {
  const log = readGraphLog(key, runId);
  mutate(log);
  writeJson(agentFiles(key, runId).graph, log);
}

export function recordGraphWarnings(key, runId, checkpoint, messages) {
  if (!runId || !messages.length) return;
  const at = new Date().toISOString();
  writeGraphLog(key, runId, (log) => {
    for (const message of messages) log.warnings.push({ at, checkpoint, message });
  });
}

// ---------- refresh ----------
const REFUSAL = /refusing to overwrite/i;

// mode: 'full' | 'incremental' | 'auto' (skip when the stamp matches HEAD and the tree).
export function ensureGraph(ctx, { mode = 'auto', checkpoint = 'manual', runId = ctx.activeRunId || null, log = (l) => console.log(l) } = {}) {
  const started = Date.now();
  const rec = { at: new Date().toISOString(), checkpoint, requested: mode, ok: false };
  const finish = () => {
    rec.ms = Date.now() - started;
    if (runId) writeGraphLog(ctx.key, runId, (l) => { l.refreshes.push(rec); });
    return rec;
  };
  const lock = waitForRebuildLock(ctx.root, {
    onWait: (h) => log(`graph: waiting for the pilothify rebuild${h.pid ? ` (pid ${h.pid})` : ''} that holds ${outDirName()}/.rebuild.lock ...`),
  });
  rec.waited_ms = lock.waited_ms;
  if (!lock.ok) {
    rec.mode = mode === 'auto' ? 'incremental' : mode;
    rec.error = `${outDirName()}/.rebuild.lock is still held by pid ${lock.holder?.pid ?? '?'} after ${(lock.waited_ms / 1000).toFixed(1)} s; `
      + 'wait for that rebuild to finish (or stop it), then run `fe graph ensure` again';
    return finish();
  }
  const before = worktreeStamp(ctx.root);
  rec.head = before.head;
  rec.fingerprint = before.fingerprint;
  rec.dirty_paths = before.dirty_paths;
  let action;
  if (!existsSync(graphFile(ctx.root))) action = 'initial';
  else if (mode === 'full') action = 'full';
  else if (mode === 'incremental') action = 'incremental';
  else action = graphFreshness(ctx.key, ctx.root, before).fresh ? 'unchanged' : 'incremental';
  rec.mode = action === 'initial' ? 'full' : action;
  if (action === 'unchanged') {
    rec.ok = true;
    rec.exit = null;
    return finish();
  }
  // The first build of a repository is code-only (docs would add `references` edges to the
  // blast radius); every later build keeps that scope through the update pipeline.
  let args = action === 'initial' ? ['extract', '.', '--code-only'] : action === 'full' ? ['update', '.', '--full'] : ['update', '.'];
  let res = runPilothify(ctx.root, args);
  if (res.error) {
    rec.command = `pilothify ${args.join(' ')}`;
    rec.exit = null;
    rec.error = res.error.code === 'ENOENT'
      ? 'pilothify is not installed (install it as compat/speckit.json → pilothify.install says)'
      : `pilothify could not run (${res.error.code || res.error.message})`;
    return finish();
  }
  if (action === 'full' && res.status === 2 && /unknown update option: --full/.test(res.stderr)) {
    rec.fallback = `pilothify ${pilothifyVersion() || '(older than 0.1.6)'} has no --full; used --force`;
    log(`graph: ${rec.fallback}, which also skips pilothify's shrink guard`);
    args = ['update', '.', '--force'];
    res = runPilothify(ctx.root, args);
  }
  rec.command = `pilothify ${args.join(' ')}`;
  rec.exit = res.status;
  const output = `${res.stdout}\n${res.stderr}`;
  if (REFUSAL.test(output)) {
    const why = output.split('\n').find((l) => REFUSAL.test(l)) || '';
    rec.error = `pilothify refused to write the graph (${rec.command}, exit ${res.status}): ${why.trim()}`;
    return finish();
  }
  if (res.status !== 0) {
    rec.error = `${rec.command} failed (exit ${res.status}): ${lastLines(output, 6)}`;
    return finish();
  }
  const counts = graphCounts(ctx.root);
  Object.assign(rec, { ok: true, nodes: counts.nodes, edges: counts.edges, built_at_commit: counts.built_at_commit });
  // The stamp is the tree as it was before the refresh: if it changed meanwhile, the next
  // check sees the difference and refreshes again.
  writeStamp(ctx.key, ctx.root, {
    head: before.head, fingerprint: before.fingerprint, mode: rec.mode, at: rec.at, exit: rec.exit, nodes: rec.nodes, edges: rec.edges,
  });
  return finish();
}

export function describeRefresh(rec) {
  if (!rec.ok) return `graph: refresh FAILED (${rec.checkpoint}): ${rec.error}`;
  const tree = `HEAD ${short(rec.head)}${rec.dirty_paths ? ` + ${rec.dirty_paths} uncommitted path(s)` : ''}`;
  const waited = rec.waited_ms ? `; waited ${(rec.waited_ms / 1000).toFixed(1)} s for another rebuild` : '';
  if (rec.mode === 'unchanged') return `graph: up to date with ${tree}; nothing to refresh${waited}.`;
  const took = ((rec.ms - (rec.waited_ms || 0)) / 1000).toFixed(1);
  return `graph: ${rec.mode} refresh done (${rec.command}, ${took} s): ${rec.nodes ?? '?'} nodes, ${rec.edges ?? '?'} edges; matches ${tree}${waited}.`;
}

// ---------- git hooks ----------
export function gitHooksState(ctx) {
  const state = pilothifyHooks(ctx.root);
  const record = readJson(gitHooksRecordFile(ctx.key));
  const managed = Boolean(record?.installed_by_fe && state.any);
  return { ...state, managed, record, linked_worktree: isLinkedWorktree(ctx.root), wanted: ctx.profile?.graph?.git_hooks !== false };
}

export function describeGitHooks(s) {
  let text;
  if (s.installed) text = s.managed ? `installed by fe-delivery (${s.dir})` : `installed (not managed by fe-delivery) (${s.dir})`;
  else if (s.partial) text = `partly installed: ${Object.entries(s.hooks).filter(([, v]) => v).map(([k]) => k).join(', ')} (${s.dir})`;
  else text = s.wanted ? 'not installed' : 'not installed (profile graph.git_hooks = false)';
  if (s.linked_worktree) text += '; this checkout is a linked worktree, where they skip rebuilds and fe refreshes the graph itself';
  return text;
}

export function installGitHooks(ctx) {
  const state = gitHooksState(ctx);
  if (state.any) {
    return state.managed
      ? { ok: true, message: `pilothify git hooks are already installed by fe-delivery in ${state.dir}.` }
      : { ok: true, message: `pilothify git hooks are already in ${state.dir} (${state.installed ? 'all four' : 'some of them'}); they are not managed by fe-delivery and are left as they are.` };
  }
  const res = runPilothify(ctx.root, ['hook', 'install', '--no-merge-driver']);
  if (res.error) return { ok: false, message: 'pilothify is not installed (see compat/speckit.json → pilothify.install).' };
  if (res.status !== 0) {
    if (/unknown hook .*option/.test(res.stderr)) {
      return { ok: false, message: `pilothify ${pilothifyVersion() || ''} cannot install hooks without the merge driver; upgrade to 0.1.6 or newer (compat/speckit.json → pilothify.install).` };
    }
    return { ok: false, message: `pilothify hook install failed (exit ${res.status}): ${lastLines(`${res.stdout}\n${res.stderr}`, 6)}` };
  }
  const after = pilothifyHooks(ctx.root);
  if (!after.installed) return { ok: false, message: `pilothify hook install reported success, but the hooks are not in ${after.dir}.` };
  writeJson(gitHooksRecordFile(ctx.key), { installed_by_fe: true, at: new Date().toISOString(), hooks_dir: after.dir, merge_driver: false });
  const rel = relative(ctx.root, after.dir);
  const inRepo = rel && !rel.startsWith('..') && !rel.startsWith('.git');
  return {
    ok: true,
    output: res.stdout.trim(),
    message: `Installed pilothify's post-commit, post-checkout, post-merge and post-rewrite hooks in ${after.dir} (no merge driver: ${outDirName()}/ is gitignored).`
      + (inRepo ? ` The hooks directory is inside the repository (${rel}); those files are tracked, so commit them to share the hooks or keep them local.` : ' They stay in this clone; every clone installs its own.'),
  };
}

export function uninstallGitHooks(ctx) {
  const record = readJson(gitHooksRecordFile(ctx.key));
  if (!record?.installed_by_fe) {
    return { ok: true, removed: false, message: 'pilothify git hooks were not installed by fe-delivery; left in place.' };
  }
  const res = runPilothify(ctx.root, ['hook', 'uninstall', '--no-merge-driver']);
  if (res.error) return { ok: false, removed: false, message: 'pilothify is not installed; remove the pilothify blocks from the git hooks by hand.' };
  if (res.status !== 0) return { ok: false, removed: false, message: `pilothify hook uninstall failed (exit ${res.status}): ${lastLines(res.stderr, 4)}` };
  rmSync(gitHooksRecordFile(ctx.key), { force: true });
  return { ok: true, removed: true, hooks_dir: record.hooks_dir, message: `Removed the pilothify git hooks fe-delivery installed in ${record.hooks_dir}.` };
}
