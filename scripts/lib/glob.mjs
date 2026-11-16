// Minimal gitignore-flavoured glob matcher (no dependencies).
// - Patterns containing "/" are anchored at the repository root.
// - Patterns without "/" match the basename at any depth (like .gitignore).
// - Supported: **, *, ?, {a,b}, [abc].
const cache = new Map();

function escapeRe(ch) {
  return /[.+^$()|\\]/.test(ch) ? `\\${ch}` : ch;
}

function translate(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const prevSlash = i === 0 || pattern[i - 1] === '/';
        const nextSlash = pattern[i + 2] === '/';
        if (prevSlash && nextSlash) {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
        continue;
      }
      const alts = pattern.slice(i + 1, end).split(',').map((a) => translate(a));
      re += `(?:${alts.join('|')})`;
      i = end + 1;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
        i += 1;
        continue;
      }
      re += pattern.slice(i, end + 1);
      i = end + 1;
    } else {
      re += escapeRe(ch);
      i += 1;
    }
  }
  return re;
}

export function globToRegExp(pattern) {
  if (cache.has(pattern)) return cache.get(pattern);
  let p = pattern.trim().replace(/^\.\//, '');
  const anchored = p.includes('/');
  if (p.endsWith('/')) p += '**';
  const body = translate(p.replace(/^\//, ''));
  const re = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  cache.set(pattern, re);
  return re;
}

export function matchGlob(pattern, relPath) {
  return globToRegExp(pattern).test(relPath.replace(/\\/g, '/'));
}

export function matchAny(patterns, relPath) {
  return (patterns || []).some((p) => matchGlob(p, relPath));
}

// Returns the risk categories (keys of `globs`) that relPath falls into.
export function riskCategories(globs, relPath) {
  return Object.entries(globs || {})
    .filter(([, patterns]) => matchAny(patterns, relPath))
    .map(([category]) => category);
}
