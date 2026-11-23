// Is the pilothify graph in step with the code? A graph matches a working tree, not a commit:
// HEAD alone misses uncommitted edits (and discarded ones). The stamp fe records after each
// successful refresh is { head, fingerprint }, where the fingerprint hashes `git status`,
// `git diff HEAD` and the content of untracked files, leaving pilothify's own output out.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { zones } from './paths.mjs';
import { readJson, writeJson } from './state.mjs';

export function outDirName() {
  return process.env.PILOTHIFY_OUT || 'pilothify-out';
}

export function outDir(root) {
  return resolve(root, outDirName());
}

export function graphFile(root) {
  return join(outDir(root), 'graph.json');
}

export function lockFile(root) {
  return join(outDir(root), '.rebuild.lock');
}

// GIT_OPTIONAL_LOCKS=0: `git status` must not take index.lock for its opportunistic index
// refresh, or a stamp computed by a hook could collide with the developer's own git command.
function git(root, args, encoding = 'utf8') {
  const res = spawnSync('git', args, {
    cwd: root, encoding, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return res.status === 0 ? res.stdout : null;
}

export function gitHead(root) {
  const out = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  return out ? out.trim() : null;
}

// A linked worktree (git worktree add) has its own git dir under the main repository's
// common dir. pilothify's git hooks skip rebuilds there, so fe has to refresh by itself.
export function isLinkedWorktree(root) {
  const out = git(root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  if (!out) return false;
  const [gitDir, commonDir] = out.trim().split('\n');
  return Boolean(gitDir && commonDir && resolve(gitDir) !== resolve(commonDir));
}

function contentDigest(file) {
  try {
    const st = statSync(file);
    if (!st.isFile()) return 'not-a-file';
    if (st.size > 8 * 1024 * 1024) return `big:${st.size}:${st.mtimeMs}`;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'missing';
  }
}

function statusEntries(statusZ) {
  const parts = statusZ.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i].slice(0, 2);
    entries.push({ code, path: parts[i].slice(3) });
    if (code.includes('R') || code.includes('C')) i += 1; // the rename source follows
  }
  return entries;
}

// The working-tree stamp: HEAD plus a fingerprint of everything uncommitted. pilothify's
// output directory is left out (it changes on every refresh).
export function worktreeStamp(root) {
  const head = gitHead(root);
  const out = outDirName().replace(/\/+$/, '');
  const pathspec = isAbsolute(out) ? ['--', '.'] : ['--', '.', `:(exclude)${out}`];
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspec]) ?? '';
  const diff = head
    ? git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--binary', ...pathspec], 'buffer')
    : git(root, ['diff', '--cached', '--no-color', '--no-ext-diff', '--binary', ...pathspec], 'buffer');
  const hash = createHash('sha256');
  hash.update(`head:${head || '-'}\0status:${status}\0diff:`);
  if (diff) hash.update(diff);
  const entries = statusEntries(status);
  for (const e of entries) {
    if (e.code === '??') hash.update(`\0untracked:${e.path}:${contentDigest(join(root, e.path))}`);
  }
  return { head, fingerprint: hash.digest('hex').slice(0, 40), dirty_paths: entries.length };
}

export const short = (sha) => (sha ? String(sha).slice(0, 7) : '?');

// ---------- the stamp of the last successful refresh, per checkout (agent zone) ----------
export function stampFile(key, root) {
  const id = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
  return join(zones.agent(key), 'graph', `${id}.json`);
}

export function readStamp(key, root) {
  return readJson(stampFile(key, root));
}

export function writeStamp(key, root, stamp) {
  writeJson(stampFile(key, root), { root: resolve(root), ...stamp });
}

// built_at_commit without parsing a large graph.json: read its first and last 64 KiB.
export function builtAtCommit(root) {
  const file = graphFile(root);
  try {
    const size = statSync(file).size;
    if (size <= 256 * 1024) {
      const g = JSON.parse(readFileSync(file, 'utf8'));
      return { exists: true, built_at_commit: typeof g.built_at_commit === 'string' ? g.built_at_commit : null };
    }
    const fd = openSync(file, 'r');
    const chunk = 64 * 1024;
    const headBuf = Buffer.alloc(chunk);
    const tailBuf = Buffer.alloc(chunk);
    readSync(fd, headBuf, 0, chunk, 0);
    readSync(fd, tailBuf, 0, chunk, size - chunk);
    closeSync(fd);
    const m = (headBuf.toString('utf8') + tailBuf.toString('utf8')).match(/"built_at_commit"\s*:\s*"([0-9a-f]{7,64})"/);
    return { exists: true, built_at_commit: m ? m[1] : null };
  } catch {
    return { exists: existsSync(file), built_at_commit: null };
  }
}

// Fresh only when fe's own stamp matches HEAD and the working tree. Without a stamp, a graph
// can only be judged stale: built_at_commit names HEAD at build time, not the tree it saw.
export function graphFreshness(key, root, current = worktreeStamp(root)) {
  const built = builtAtCommit(root);
  if (!built.exists) return { fresh: false, reason: 'no graph yet', current, graph: false };
  const recorded = readStamp(key, root);
  if (!recorded) {
    if (!built.built_at_commit) return { fresh: false, reason: 'graph.json has no built_at_commit', current, graph: true };
    if (built.built_at_commit !== current.head) {
      return { fresh: false, reason: `graph built at ${short(built.built_at_commit)}, HEAD is ${short(current.head)}`, current, graph: true };
    }
    return { fresh: false, reason: 'not refreshed by fe-delivery yet, so uncommitted or discarded changes may be missing', current, graph: true };
  }
  if (recorded.head !== current.head) {
    return { fresh: false, reason: `HEAD moved (${short(recorded.head)} → ${short(current.head)})`, current, recorded, graph: true };
  }
  if (recorded.fingerprint !== current.fingerprint) {
    return { fresh: false, reason: 'working tree changed since the last refresh', current, recorded, graph: true };
  }
  return { fresh: true, reason: null, current, recorded, graph: true };
}

// ---------- pilothify's rebuild lock ----------
// pilothify writes its PID into pilothify-out/.rebuild.lock while a rebuild holds the flock,
// and unlinks the file on release. A file left by a killed process names a dead PID.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function lockHolder(root) {
  const file = lockFile(root);
  let text;
  let st;
  try {
    st = statSync(file);
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(String(text).trim().split(/\s+/)[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // Between creating the file and writing its PID; a leftover after that is not a holder.
    return Date.now() - st.mtimeMs < 5000 ? { pid: null, since: st.mtimeMs } : null;
  }
  return alive(pid) ? { pid, since: st.mtimeMs } : null;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function lockTimeoutMs() {
  const v = Number(process.env.FE_DELIVERY_GRAPH_LOCK_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 100000;
}

export function waitForRebuildLock(root, { timeoutMs = lockTimeoutMs(), pollMs = 200, onWait } = {}) {
  const start = Date.now();
  let holder = lockHolder(root);
  if (!holder) return { ok: true, waited_ms: 0 };
  if (onWait) onWait(holder);
  while (holder) {
    const waited = Date.now() - start;
    if (waited >= timeoutMs) return { ok: false, waited_ms: waited, holder };
    sleep(Math.min(pollMs, Math.max(10, timeoutMs - waited)));
    holder = lockHolder(root);
  }
  return { ok: true, waited_ms: Date.now() - start };
}

// ---------- pilothify's git hooks ----------
export const PILOTHIFY_HOOK_MARKERS = {
  'post-commit': '# pilothify-hook-start',
  'post-checkout': '# pilothify-checkout-hook-start',
  'post-merge': '# pilothify-merge-hook-start',
  'post-rewrite': '# pilothify-rewrite-hook-start',
};

// Where git runs hooks from (core.hooksPath honoured; Husky 9's `.husky/_` wrappers call the
// user hooks in `.husky/`, which is where pilothify writes).
export function hooksDir(root) {
  const out = git(root, ['rev-parse', '--git-path', 'hooks']);
  if (!out) return null;
  const dir = resolve(root, out.trim());
  return basename(dir) === '_' ? dirname(dir) : dir;
}

export function pilothifyHooks(root) {
  const dir = hooksDir(root);
  const hooks = {};
  for (const [name, marker] of Object.entries(PILOTHIFY_HOOK_MARKERS)) {
    let text = '';
    try {
      text = dir ? readFileSync(join(dir, name), 'utf8') : '';
    } catch {
      text = '';
    }
    hooks[name] = text.includes(marker);
  }
  const count = Object.values(hooks).filter(Boolean).length;
  return { dir, hooks, installed: count === 4, partial: count > 0 && count < 4, any: count > 0 };
}

export function gitHooksRecordFile(key) {
  return join(zones.agent(key), 'git-hooks.json');
}
