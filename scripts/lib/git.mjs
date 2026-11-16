import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function git(cwd, args, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
  } catch {
    return null;
  }
}

export function toplevel(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!out) return null;
  try {
    return realpathSync(out.trim());
  } catch {
    return resolve(out.trim());
  }
}

export function commonDir(cwd) {
  const out = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return out ? out.trim() : null;
}

export function head(cwd) {
  const out = git(cwd, ['rev-parse', 'HEAD']);
  return out ? out.trim() : null;
}

export function statusPaths(cwd) {
  const out = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!out) return [];
  const paths = [];
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code.includes('R') || code.includes('C')) i += 1; // skip rename source
  }
  return paths;
}

// Tracked changes (committed + staged + unstaged) since base.
export function numstat(cwd, base) {
  const out = git(cwd, ['diff', '--numstat', '-z', base]);
  if (out === null) return [];
  const rows = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    const m = part.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      // rename: next two entries are old and new path
      path = parts[i + 2] || parts[i + 1] || '';
      i += 2;
    }
    rows.push({ path, added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return rows;
}

export function untracked(cwd) {
  const out = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out ? out.split('\0').filter(Boolean) : [];
}

export function addedLines(cwd, base) {
  const out = git(cwd, ['diff', '-U0', '--no-color', base]);
  if (!out) return [];
  const result = [];
  let file = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
    } else if (file && line.startsWith('+') && !line.startsWith('+++')) {
      result.push({ path: file, text: line.slice(1) });
    }
  }
  return result;
}
