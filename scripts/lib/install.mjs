// Manifest-based install / uninstall of fe-delivery's per-repository footprint.
//
// Guarantees:
//  - install never overwrites a value or file the repository already has; it only adds missing
//    keys, missing array items, marked blocks and new files, and records each one;
//  - uninstall touches only paths recorded in the manifest (plus .fe-delivery/ itself);
//    a file unchanged since install is restored byte for byte, an edited file has only
//    fe-delivery's own parts removed, and anything it cannot remove safely is reported;
//  - product source (src/, specs/, worktrees, branches) is never read for writing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pluginRoot } from './paths.mjs';

export const MANIFEST = '.fe-delivery/install-manifest.json';
export const PROFILE = '.fe-delivery/profile.json';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const exists = (root, rel) => existsSync(join(root, rel));
const fileSha = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');
// Tests point this at a stub; real uninstalls use the Spec Kit CLI on PATH.
const specifyBin = () => process.env.FE_DELIVERY_SPECIFY_BIN || 'specify';

// ---------------- Spec Kit footprint (only when fe-setup installed Spec Kit) ----------------
// Files `specify init` / `specify extension add` created: under .specify/, the speckit-* skills
// and speckit commands. Recorded at install time so `fe uninstall --speckit` can remove exactly
// those that are still unchanged and keep the ones the team edited (for example the constitution).
const isSpeckitPath = (p) => p.startsWith('.specify/') || /^\.claude\/skills\/speckit-[^/]+\//.test(p) || /^\.claude\/commands\/speckit[^/]*$/.test(p);

function walk(root, rel, out) {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, p, out);
    else if (e.isFile() && isSpeckitPath(p)) out.push(p);
  }
  return out;
}

export function speckitFiles(root) {
  return ['.specify', '.claude/skills', '.claude/commands'].flatMap((d) => walk(root, d, [])).sort();
}

function pruneEmptyDirs(root, rel) {
  const abs = join(root, rel);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) pruneEmptyDirs(root, `${rel}/${e.name}`);
  if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true });
}

// Paths git ignores in this repository, with the rule that ignores them.
export function ignoredBy(root, paths) {
  const res = spawnSync('git', ['check-ignore', '-v', '--no-index', '--', ...paths], { cwd: root, encoding: 'utf8' });
  const out = {};
  for (const line of (res.stdout || '').split('\n').filter(Boolean)) {
    const [rule, path] = line.split('\t');
    // -v also reports a matching negation ("!pattern"): that path is re-included, not ignored.
    const pattern = rule.split(':').slice(2).join(':');
    if (path && !pattern.startsWith('!')) out[path] = rule;
  }
  return out;
}


let createdDirs = null; // collected during install so uninstall can remove directories it created

function write(root, rel, text) {
  if (createdDirs) {
    let dir = dirname(rel);
    while (dir && dir !== '.' && !existsSync(join(root, dir))) {
      createdDirs.add(dir);
      dir = dirname(dir);
    }
  }
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(pluginRoot(), '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// ---------------- JSON merge (settings.json) ----------------
// Adds what `template` has and `target` lacks. Records one entry per touch point:
//   { path, existed: false, ours: <subtree set> }       key was absent, fe-delivery set it
//   { path, existed: true,  ours: [items added] }       array existed, fe-delivery appended items
// Conflicting scalars stay as the repository had them and are reported.
export function mergeJson(target, template, path = [], records = [], conflicts = []) {
  for (const [key, value] of Object.entries(template)) {
    const p = [...path, key];
    if (!(key in target)) {
      target[key] = structuredClone(value);
      records.push({ path: p, existed: false, ours: structuredClone(value) });
    } else if (Array.isArray(value) && Array.isArray(target[key])) {
      const added = value.filter((v) => !target[key].some((t) => deepEqual(t, v)));
      if (added.length) {
        target[key].push(...structuredClone(added));
        records.push({ path: p, existed: true, ours: structuredClone(added) });
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeJson(target[key], value, p, records, conflicts);
    } else if (!deepEqual(target[key], value)) {
      conflicts.push({ path: p, kept: target[key], wanted: value });
    }
  }
  return { records, conflicts };
}

function getAt(obj, path) {
  return path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

// Removes from `current` the parts equal to `ours`. Returns true when `current` ends up empty.
function subtract(current, ours) {
  if (current && ours && typeof current === 'object' && typeof ours === 'object' && !Array.isArray(current) && !Array.isArray(ours)) {
    for (const [k, v] of Object.entries(ours)) {
      if (!(k in current)) continue;
      if (deepEqual(current[k], v)) delete current[k];
      else if (subtract(current[k], v)) delete current[k];
    }
    return Object.keys(current).length === 0;
  }
  if (Array.isArray(current) && Array.isArray(ours)) {
    for (const item of ours) {
      const i = current.findIndex((c) => deepEqual(c, item));
      if (i >= 0) current.splice(i, 1);
    }
    return current.length === 0;
  }
  return deepEqual(current, ours);
}

export function unmergeJson(obj, records) {
  const leftovers = [];
  for (const r of [...records].reverse()) {
    const parent = getAt(obj, r.path.slice(0, -1));
    const key = r.path[r.path.length - 1];
    if (!parent || typeof parent !== 'object' || !(key in parent)) continue;
    if (r.existed) {
      const arr = parent[key];
      if (!Array.isArray(arr)) {
        leftovers.push({ path: r.path, reason: 'array was replaced after install' });
        continue;
      }
      for (const item of r.ours) {
        const i = arr.findIndex((c) => deepEqual(c, item));
        if (i >= 0) arr.splice(i, 1);
      }
    } else if (deepEqual(parent[key], r.ours) || subtract(parent[key], r.ours)) {
      delete parent[key];
    } else {
      leftovers.push({ path: r.path, reason: 'kept values you added or changed after install' });
    }
  }
  return leftovers;
}

// ---------------- marked text blocks ----------------
function markers(rel) {
  return rel.endsWith('.md')
    ? ['<!-- fe-delivery:begin -->', '<!-- fe-delivery:end -->']
    : ['# fe-delivery:begin', '# fe-delivery:end'];
}

// fe-delivery 0.3.0 and earlier wrote this line into the CLAUDE.md block. Runs now work in the
// current checkout, so repositories that still carry it get a notice; the plugin never edits it.
const LEGACY_WORKTREE_LINE = 'Delivery runs work in a git worktree: create one with EnterWorktree for each run.';

export function legacyWorktreeLine(root) {
  try {
    return read(root, 'CLAUDE.md').includes(LEGACY_WORKTREE_LINE);
  } catch {
    return false;
  }
}

export function legacyWorktreeNotice() {
  return 'CLAUDE.md still says delivery runs work in a git worktree (a line fe-delivery 0.3.0 and earlier wrote). It no longer applies: work in the current checkout and make a worktree only when the user asks for one. Offer to replace that line with the current one from the plugin\'s templates/claude-md-block.md; fe-delivery does not edit CLAUDE.md.';
}

function appendBlock(root, rel, content, ops, skipIfIncludes = null) {
  const existed = exists(root, rel);
  const before = existed ? read(root, rel) : '';
  const [begin, end] = markers(rel);
  if (before.includes(begin)) {
    ops.push({ op: 'skip', path: rel, reason: 'an fe-delivery block is already present' });
    return;
  }
  if (skipIfIncludes && before.split('\n').some((l) => l.trim() === skipIfIncludes)) {
    ops.push({ op: 'skip', path: rel, reason: `already contains "${skipIfIncludes}"` });
    return;
  }
  const sep = before === '' ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const block = `${sep}${begin}\n${content.endsWith('\n') ? content : `${content}\n`}${end}\n`;
  write(root, rel, before + block);
  ops.push({ op: 'append-block', path: rel, existed, block, after_sha256: sha(before + block) });
}

function removeBlock(text, op) {
  if (text.endsWith(op.block)) return { text: text.slice(0, -op.block.length), how: 'exact' };
  const at = text.indexOf(op.block);
  if (at >= 0) return { text: text.slice(0, at) + text.slice(at + op.block.length), how: 'exact' };
  const [begin, end] = markers(op.path);
  const b = text.indexOf(begin);
  const e = text.indexOf(end, b);
  if (b >= 0 && e >= 0) {
    let start = b;
    while (start > 0 && text[start - 1] === '\n' && text[start - 2] === '\n') start -= 1;
    const stop = text[e + end.length] === '\n' ? e + end.length + 1 : e + end.length;
    return { text: text.slice(0, start) + text.slice(stop), how: 'markers' };
  }
  return null;
}

// ---------------- install ----------------
export function install(root, { profileText, speckitInstalledBySetup = false }) {
  if (exists(root, MANIFEST)) throw new Error(`${MANIFEST} already exists: fe-delivery is installed (run \`fe uninstall\` first)`);
  if (exists(root, PROFILE)) throw new Error(`${PROFILE} already exists but there is no install manifest; remove it or install manually`);
  const ops = [];
  createdDirs = new Set();
  const tpl = (name) => readFileSync(join(pluginRoot(), 'templates', name), 'utf8');

  // settings.json must parse before anything is written
  const settingsRel = '.claude/settings.json';
  const settingsExisted = exists(root, settingsRel);
  const settingsBefore = settingsExisted ? read(root, settingsRel) : '';
  let settings = {};
  if (settingsExisted) {
    try {
      settings = JSON.parse(settingsBefore);
    } catch (e) {
      throw new Error(`${settingsRel} is not valid JSON (${e.message}); fix it before installing`);
    }
  }

  write(root, PROFILE, profileText.endsWith('\n') ? profileText : `${profileText}\n`);
  ops.push({ op: 'create', path: PROFILE, sha256: sha(read(root, PROFILE)) });

  const { records, conflicts } = mergeJson(settings, JSON.parse(tpl('settings.example.json')));
  if (records.length) {
    const after = `${JSON.stringify(settings, null, 2)}\n`;
    write(root, settingsRel, after);
    ops.push({
      op: 'json-merge', path: settingsRel, existed: settingsExisted,
      before_text: settingsExisted ? settingsBefore : null, after_sha256: sha(after), records, conflicts,
    });
  } else {
    ops.push({ op: 'skip', path: settingsRel, reason: 'already contains every fe-delivery entry', conflicts });
  }

  appendBlock(root, 'CLAUDE.md', tpl('claude-md-block.md'), ops);
  appendBlock(root, '.gitignore', 'pilothify-out/\n', ops, 'pilothify-out/');

  for (const [rel, name] of [['.pilothifyignore', 'pilothifyignore'], ['.pilothifyrc', 'pilothifyrc']]) {
    if (exists(root, rel)) {
      ops.push({ op: 'skip', path: rel, reason: 'file already exists; left untouched' });
    } else {
      write(root, rel, tpl(name));
      ops.push({ op: 'create', path: rel, sha256: sha(read(root, rel)) });
    }
  }

  const manifest = {
    fe_delivery_version: pluginVersion(),
    installed_at: new Date().toISOString(),
    speckit_installed_by_setup: Boolean(speckitInstalledBySetup),
    speckit_files: speckitInstalledBySetup ? speckitFiles(root).map((p) => ({ path: p, sha256: fileSha(join(root, p)) })) : [],
    pilothify_out_existed: exists(root, 'pilothify-out'),
    created_dirs: [...createdDirs].sort((a, b) => b.length - a.length),
    operations: ops,
  };
  // A reminder only: the repository's .gitignore is the team's business, fe-delivery never edits it
  // beyond its own marked block.
  const ignored = ignoredBy(root, [PROFILE, MANIFEST, '.claude/settings.json']);
  manifest.warnings = Object.entries(ignored).map(([path, rule]) => (
    `${path} is ignored by git (${rule}); it stays on this machine and does not reach teammates through the repository`
  ));
  createdDirs = null;
  write(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ---------------- uninstall ----------------
function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function changedPaths(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const set = new Map();
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i].slice(0, 2);
    const p = parts[i].slice(3);
    set.set(p, code);
    if (code.includes('R') || code.includes('C')) i += 1;
  }
  return set;
}

export function readManifest(root) {
  if (!exists(root, MANIFEST)) return null;
  return JSON.parse(read(root, MANIFEST));
}

export function planUninstall(root, manifest, opts = {}) {
  const steps = [];
  for (const op of [...manifest.operations].reverse()) {
    if (op.op === 'skip') continue;
    const present = exists(root, op.path);
    if (op.op === 'create') {
      if (!present) steps.push({ path: op.path, action: 'none', why: 'already gone' });
      else if (sha(read(root, op.path)) === op.sha256) steps.push({ path: op.path, action: 'delete', why: 'unchanged since install' });
      else if (op.path.startsWith('.fe-delivery/')) steps.push({ path: op.path, action: 'delete', why: 'fe-delivery configuration (edited after install)' });
      else steps.push({ path: op.path, action: 'keep', why: 'edited after install; the repository may use it now' });
    } else if (op.op === 'json-merge') {
      if (!present) steps.push({ path: op.path, action: 'none', why: 'already gone' });
      else if (sha(read(root, op.path)) === op.after_sha256) {
        steps.push({ path: op.path, action: op.existed ? 'restore' : 'delete', why: 'unchanged since install; restored byte for byte' });
      } else {
        steps.push({ path: op.path, action: 'remove-entries', why: `edited after install; removing only ${op.records.length} fe-delivery entries` });
      }
    } else if (op.op === 'append-block') {
      if (!present) steps.push({ path: op.path, action: 'none', why: 'already gone' });
      else {
        const res = removeBlock(read(root, op.path), op);
        if (!res) steps.push({ path: op.path, action: 'keep', why: 'fe-delivery block not found (edited); remove it by hand' });
        else if (!op.existed && res.text === '') steps.push({ path: op.path, action: 'delete', why: 'file was created by install and holds only the fe-delivery block' });
        else steps.push({ path: op.path, action: 'remove-block', why: res.how === 'exact' ? 'block unchanged' : 'block edited; removing the marked region' });
      }
    }
  }
  if (!manifest.pilothify_out_existed && exists(root, 'pilothify-out')) {
    steps.push({ path: 'pilothify-out/', action: 'delete', why: 'generated graph created after install (gitignored, rebuildable)' });
  }
  steps.push({ path: MANIFEST, action: 'delete', why: 'install record' });
  const optional = [];
  if (manifest.speckit_installed_by_setup) {
    const files = manifest.speckit_files || [];
    const edited = files.filter((f) => exists(root, f.path) && fileSha(join(root, f.path)) !== f.sha256).map((f) => f.path);
    optional.push({
      flag: '--speckit',
      commands: ['specify extension remove bug --force', 'specify integration uninstall claude', `delete the ${files.length - edited.length} unchanged files Spec Kit's setup created`],
      why: `Spec Kit was installed by fe-setup${edited.length ? `; edited files are kept: ${edited.join(', ')}` : ''}`,
    });
  }
  return { steps, optional, untouched: ['src/ and every product file', 'specs/ (Spec Kit artifacts of past runs)', '.specify/memory/constitution.md once the team has written it', 'git worktrees and branches', 'commit history'] };
}

export function applyUninstall(root, manifest, opts = {}) {
  const before = changedPaths(root);
  const report = [];
  const allowed = new Set([MANIFEST, 'pilothify-out/']);
  for (const op of [...manifest.operations].reverse()) {
    if (op.op === 'skip') continue;
    allowed.add(op.path);
    const file = join(root, op.path);
    if (!existsSync(file)) {
      report.push(`${op.path}: already gone`);
      continue;
    }
    if (op.op === 'create') {
      const same = sha(read(root, op.path)) === op.sha256;
      if (same || op.path.startsWith('.fe-delivery/')) {
        rmSync(file);
        report.push(`${op.path}: deleted${same ? '' : ' (had been edited)'}`);
      } else {
        report.push(`${op.path}: KEPT (edited after install)`);
      }
    } else if (op.op === 'json-merge') {
      const text = read(root, op.path);
      if (sha(text) === op.after_sha256) {
        if (op.existed) writeFileSync(file, op.before_text);
        else rmSync(file);
        report.push(`${op.path}: ${op.existed ? 'restored byte for byte' : 'deleted (created by install)'}`);
      } else {
        let obj;
        try {
          obj = JSON.parse(text);
        } catch {
          report.push(`${op.path}: KEPT (no longer valid JSON; remove fe-delivery entries by hand)`);
          continue;
        }
        const leftovers = unmergeJson(obj, op.records);
        if (!op.existed && Object.keys(obj).length === 0) {
          rmSync(file);
          report.push(`${op.path}: deleted (only fe-delivery entries were left)`);
        } else {
          writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
          report.push(`${op.path}: removed fe-delivery entries, kept yours${leftovers.length ? `; review: ${leftovers.map((l) => l.path.join('.')).join(', ')}` : ''}`);
        }
      }
    } else if (op.op === 'append-block') {
      const res = removeBlock(read(root, op.path), op);
      if (!res) {
        report.push(`${op.path}: KEPT (fe-delivery block not found)`);
      } else if (!op.existed && res.text === '') {
        rmSync(file);
        report.push(`${op.path}: deleted (created by install)`);
      } else {
        writeFileSync(file, res.text);
        report.push(`${op.path}: removed the fe-delivery block`);
      }
    }
  }
  if (!manifest.pilothify_out_existed && exists(root, 'pilothify-out')) {
    rmSync(join(root, 'pilothify-out'), { recursive: true, force: true });
    report.push('pilothify-out/: deleted (generated after install)');
  }
  rmSync(join(root, MANIFEST), { force: true });
  const feDir = join(root, '.fe-delivery');
  if (existsSync(feDir) && readdirSync(feDir).length === 0) rmSync(feDir, { recursive: true });
  else if (existsSync(feDir)) report.push(`.fe-delivery/: KEPT (contains files fe-delivery did not create: ${readdirSync(feDir).join(', ')})`);
  for (const dir of manifest.created_dirs || []) {
    const abs = join(root, dir);
    if (existsSync(abs) && readdirSync(abs).length === 0) {
      rmSync(abs, { recursive: true });
      report.push(`${dir}/: removed (empty directory created by install)`);
    }
  }
  report.push('manifest: deleted');

  if (opts.speckit && manifest.speckit_installed_by_setup) {
    // Judge "unchanged since install" before Spec Kit's own commands rewrite its registry files.
    const unchanged = [];
    const edited = [];
    for (const f of manifest.speckit_files || []) {
      const abs = join(root, f.path);
      if (!existsSync(abs)) continue;
      (fileSha(abs) === f.sha256 ? unchanged : edited).push(f.path);
    }
    const beforeFiles = new Set(speckitFiles(root));
    for (const args of [['extension', 'remove', 'bug', '--force'], ['integration', 'uninstall', 'claude']]) {
      const r = spawnSync(specifyBin(), args, { cwd: root, encoding: 'utf8', input: '' });
      report.push(`specify ${args.join(' ')}: exit ${r.status}`);
    }
    // Backups and other files Spec Kit's removal just wrote belong to this uninstall too.
    const createdNow = speckitFiles(root).filter((p) => !beforeFiles.has(p));
    let removed = 0;
    for (const p of [...unchanged, ...createdNow]) {
      if (existsSync(join(root, p))) {
        rmSync(join(root, p));
        removed += 1;
      }
    }
    for (const d of ['.specify', '.claude/skills', '.claude/commands']) pruneEmptyDirs(root, d);
    if (existsSync(join(root, '.claude')) && readdirSync(join(root, '.claude')).length === 0) rmSync(join(root, '.claude'), { recursive: true });
    report.push(`Spec Kit files created by setup: ${removed} removed`);
    if (edited.length) report.push(`Spec Kit files KEPT (edited after install): ${edited.join(', ')}`);
    const recorded = new Set((manifest.speckit_files || []).map((f) => f.path));
    const other = speckitFiles(root).filter((p) => !recorded.has(p));
    if (other.length) report.push(`Spec Kit files KEPT (created after install, e.g. by runs): ${other.slice(0, 10).join(', ')}${other.length > 10 ? ', …' : ''}`);
  }

  // Safety net: nothing outside the manifest may have changed.
  const after = changedPaths(root);
  const violations = [];
  for (const [p, code] of after) {
    if (before.get(p) === code) continue;
    const ok = [...allowed].some((a) => p === a || (a.endsWith('/') && p.startsWith(a)))
      || p.startsWith('.fe-delivery/')
      || (opts.speckit && (p.startsWith('.claude/skills/speckit-') || p.startsWith('.claude/commands/speckit') || p.startsWith('.specify/')));
    if (!ok) violations.push(p);
  }
  return { report, violations };
}

export function activeRunsFor(hookZoneActiveFile) {
  try {
    return Object.entries(JSON.parse(readFileSync(hookZoneActiveFile, 'utf8')));
  } catch {
    return [];
  }
}
