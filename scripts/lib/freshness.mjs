// Is the pilothify graph in step with the code? A graph matches a working tree, not a commit:
// HEAD alone misses uncommitted edits (and discarded ones). The stamp fe records after each
// successful refresh is { head, fingerprint }, where the fingerprint hashes `git status`,
// `git diff HEAD` and the content of untracked files. It leaves out pilothify's own output,
// and the files Claude Code's sandbox cannot read (see SECRET_GLOBS), so a stamp computed
// inside the sandbox matches one computed outside it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
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

// Files Claude Code's sandbox refuses to read: the `Read(...)` denies of
// templates/settings.example.json, at any depth. Inside the sandbox git cannot lstat them:
// `git diff HEAD` lists them as deleted while `git status` skips them. Outside, git sees them
// as they are. Counting them would give one working tree two fingerprints, depending on
// where it was computed. pilothify never puts these files in the graph.
export const SECRET_GLOBS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key'];

function stampPathspec() {
  const out = outDirName().replace(/\/+$/, '');
  return ['--', '.', ...(isAbsolute(out) ? [] : [`:(exclude)${out}`]), ...SECRET_GLOBS.map((g) => `:(exclude,glob)${g}`)];
}

// ---------- paths this process may not read ----------
// A deny rule beyond SECRET_GLOBS (a team's own `Read(...)` denies) hides paths from the
// sandbox only. Inside, a tracked file under such a rule reads as deleted, and an untracked
// one is listed by name but cannot be read; a denied folder cannot even be listed. Such paths
// are left out of the fingerprint as "units" (a file, or the widest unlistable folder above
// it), and a stamp records its units so that the other side of the sandbox, which can read
// them, leaves the same paths out when it compares (see graphFreshness).
const denied = (e) => e?.code === 'EPERM' || e?.code === 'EACCES';

function unreadable(root, rel) {
  try {
    lstatSync(join(root, rel));
    return false;
  } catch (e) {
    return denied(e);
  }
}

function hiddenUnit(root, rel, unlistable) {
  let unit = rel;
  for (let dir = posix.dirname(rel); dir && dir !== '.'; dir = posix.dirname(dir)) {
    if (!unlistable.has(dir)) {
      let blocked = false;
      try {
        readdirSync(join(root, dir));
      } catch (e) {
        blocked = denied(e);
      }
      unlistable.set(dir, blocked);
    }
    if (!unlistable.get(dir)) break;
    unit = dir;
  }
  return unit;
}

// Units must stay well below the OS argument limit (about 1 MiB on macOS): a spawn that fails
// with E2BIG must never pass for a clean tree.
function unitLimits() {
  const n = Number(process.env.FE_DELIVERY_UNREADABLE_MAX);
  return { max: Number.isInteger(n) && n >= 0 ? n : 1000, bytes: 200000 };
}

// Drops units inside another unit; null when there are too many to pass to git.
function collapseUnits(units) {
  const set = new Set(units);
  const kept = [...set].sort().filter((u) => {
    for (let dir = posix.dirname(u); dir && dir !== '.'; dir = posix.dirname(dir)) if (set.has(dir)) return false;
    return true;
  });
  const { max, bytes } = unitLimits();
  if (kept.length > max || kept.reduce((n, u) => n + u.length + 20, 0) > bytes) return null;
  return kept;
}

// A unit is a repository-relative path that git could print: never `.`, the repository itself,
// which no writer records and which would hide every change.
const safeUnit = (u) => typeof u === 'string' && !u.startsWith('/') && !u.endsWith('/')
  && u.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

// Removes the untracked records of `paths` from `git status --porcelain=v1 -z` output, giving
// what git prints when those paths are excluded by pathspec.
function dropUntracked(status, paths) {
  const parts = status.split('\0');
  const kept = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (!rec) continue;
    const code = rec.slice(0, 2);
    if (code === '??' && paths.has(rec.slice(3))) continue;
    kept.push(rec);
    if (code.includes('R') || code.includes('C')) {
      i += 1;
      kept.push(parts[i]);
    }
  }
  return kept.length ? `${kept.join('\0')}\0` : '';
}

function unavailable(head, error) {
  return { head, fingerprint: null, dirty_paths: 0, unreadable: [], error };
}

// The working-tree stamp: HEAD plus a fingerprint of everything uncommitted. Left out:
// pilothify's output directory (it changes on every refresh), SECRET_GLOBS, the paths this
// process may not read (`unreadable`, recorded with the stamp), and `carried`, the units a
// stamp written on the other side of the sandbox recorded. Limits, all with deny rules
// beyond SECRET_GLOBS:
// - A writer outside the sandbox (the background refresh) reads such files and cannot leave
//   them out. When they are untracked or edited, the next check inside refreshes once and
//   records the units.
// - Inside, some files are not seen at all: untracked files in an unlistable folder that
//   holds no tracked file, and files staged into a path denied file by file.
// When git fails, or there are too many units, the fingerprint is null and the graph reads
// as stale.
export function worktreeStamp(root, { carried = [] } = {}) {
  const head = gitHead(root);
  const base = stampPathspec();
  const own = [];
  if (head) {
    const deleted = git(root, ['diff', 'HEAD', '--name-only', '--no-renames', '--diff-filter=D', '-z', ...base]);
    if (deleted === null) return unavailable(head, 'git diff failed');
    const unlistable = new Map();
    for (const p of deleted.split('\0').filter(Boolean)) if (unreadable(root, p)) own.push(hiddenUnit(root, p, unlistable));
  }
  const excludeArgs = (units) => units.map((u) => `:(exclude,literal)${u}`);
  let units = collapseUnits([...carried.filter(safeUnit), ...own]);
  if (units === null) return unavailable(head, `${own.length + carried.length} paths are unreadable here, too many to leave out`);
  let status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...base, ...excludeArgs(units)]);
  if (status === null) return unavailable(head, 'git status failed');
  const hiddenUntracked = new Set(statusEntries(status).filter((e) => e.code === '??' && unreadable(root, e.path)).map((e) => e.path));
  if (hiddenUntracked.size) {
    own.push(...hiddenUntracked);
    status = dropUntracked(status, hiddenUntracked);
    units = collapseUnits([...units, ...hiddenUntracked]);
    if (units === null) return unavailable(head, `${own.length + carried.length} paths are unreadable here, too many to leave out`);
  }
  const pathspec = [...base, ...excludeArgs(units)];
  const diff = head
    ? git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--binary', ...pathspec], 'buffer')
    : git(root, ['diff', '--cached', '--no-color', '--no-ext-diff', '--binary', ...pathspec], 'buffer');
  if (diff === null) return unavailable(head, 'git diff failed');
  const hash = createHash('sha256');
  hash.update(`head:${head || '-'}\0status:${status}\0diff:`);
  hash.update(diff);
  const entries = statusEntries(status);
  for (const e of entries) {
    if (e.code === '??') hash.update(`\0untracked:${e.path}:${contentDigest(join(root, e.path))}`);
  }
  return { head, fingerprint: hash.digest('hex').slice(0, 40), dirty_paths: entries.length, unreadable: collapseUnits(own) || own };
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

// Full output of the last pilothify run that failed or refused to write, next to the stamp.
export function failureLogFile(key, root) {
  return stampFile(key, root).replace(/\.json$/, '.last-failure.log');
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
export function graphFreshness(key, root, current = null) {
  const built = builtAtCommit(root);
  const recorded = readStamp(key, root);
  // Leave out what the writer of the stamp could not read, so both sides compare the same
  // paths. A `current` computed without those units is recomputed.
  const carried = Array.isArray(recorded?.unreadable) ? recorded.unreadable : [];
  if (!current || carried.length) current = worktreeStamp(root, { carried });
  if (!built.exists) return { fresh: false, reason: 'no graph yet', current, graph: false };
  if (current.fingerprint === null) {
    return { fresh: false, reason: `the working tree could not be fingerprinted (${current.error})`, current, recorded, graph: true };
  }
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
