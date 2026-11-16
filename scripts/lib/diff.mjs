// Diff facts for a run, computed by hooks from git (never from model claims).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addedLines, numstat, untracked } from './git.mjs';
import { riskCategories } from './glob.mjs';
import { isArtifactPath } from './paths.mjs';

const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i;

function countLines(file) {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) return 0;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\0')) return 0;
    return text.split('\n').length;
  } catch {
    return 0;
  }
}

function contentDigest(file) {
  try {
    const st = statSync(file);
    if (st.size > 8 * 1024 * 1024) return `big:${st.size}:${st.mtimeMs}`;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'deleted';
  }
}

export function computeDiff(root, baseSha, profile, excluded = []) {
  const skip = new Set(excluded);
  const files = new Map();
  for (const row of numstat(root, baseSha)) {
    if (!row.path || skip.has(row.path) || isArtifactPath(row.path)) continue;
    files.set(row.path, { path: row.path, added: row.added, removed: row.removed });
  }
  for (const path of untracked(root)) {
    if (skip.has(path) || isArtifactPath(path) || files.has(path)) continue;
    files.set(path, { path, added: countLines(join(root, path)), removed: 0 });
  }
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const globs = profile?.risk?.globs || {};
  const riskHits = [];
  for (const f of list) {
    for (const category of riskCategories(globs, f.path)) riskHits.push({ category, path: f.path });
  }
  const patterns = profile?.risk?.content_patterns || [];
  const contentHits = [];
  if (patterns.length) {
    for (const { path, text } of addedLines(root, baseSha)) {
      if (isArtifactPath(path) || skip.has(path)) continue;
      for (const p of patterns) if (text.includes(p)) contentHits.push({ pattern: p, path });
    }
    for (const path of untracked(root)) {
      if (isArtifactPath(path) || skip.has(path)) continue;
      let text = '';
      try {
        text = readFileSync(join(root, path), 'utf8');
      } catch {
        continue;
      }
      for (const p of patterns) if (text.includes(p)) contentHits.push({ pattern: p, path });
    }
  }
  const totalLoc = list.reduce((n, f) => n + f.added + f.removed, 0);
  // Fingerprint the content, not only line counts: an edit that keeps the counts
  // (a = 1 → a = 2) must still invalidate earlier evidence.
  const hash = createHash('sha256').update(JSON.stringify(list));
  for (const f of list) hash.update(`\0${f.path}\0${contentDigest(join(root, f.path))}`);
  const fingerprint = hash.digest('hex');
  return {
    files: list,
    total_files: list.length,
    total_loc: totalLoc,
    ui_changed: list.some((f) => UI_FILE.test(f.path)),
    risk_hits: riskHits,
    content_hits: contentHits,
    fingerprint,
  };
}

export function observedRiskCategories(diff) {
  const cats = new Set((diff?.risk_hits || []).map((h) => h.category));
  for (const h of diff?.content_hits || []) cats.add(`content:${h.pattern}`);
  return [...cats];
}

export function budgetExceeded(profile, tier, diff) {
  const budget = profile?.tiers?.[tier];
  if (!budget || !diff) return null;
  if (diff.total_files > budget.max_files) return `files ${diff.total_files} > ${budget.max_files}`;
  if (diff.total_loc > budget.max_loc) return `changed lines ${diff.total_loc} > ${budget.max_loc}`;
  return null;
}
