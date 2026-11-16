// Minimal semver: X.Y.Z (pre-release ignored) and space-separated comparator ranges
// such as ">=1.4.0 <1.5.0", "^0.1.5", "~1.4.0", "=1.4.0", "1.4.0".
export function parse(version) {
  const m = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function comparatorOk(version, comp) {
  const m = comp.match(/^(>=|<=|>|<|=|\^|~)?\s*(\d+\.\d+\.\d+)$/);
  if (!m) return false;
  const [, op = '=', target] = m;
  const c = compare(version, target);
  if (Number.isNaN(c)) return false;
  const [maj, min] = parse(target);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '^': {
      const upper = maj > 0 ? `${maj + 1}.0.0` : `0.${min + 1}.0`;
      return c >= 0 && compare(version, upper) < 0;
    }
    case '~': return c >= 0 && compare(version, `${maj}.${min + 1}.0`) < 0;
    default: return false;
  }
}

export function satisfies(version, range) {
  if (!parse(version)) return false;
  const comps = String(range || '').trim().split(/\s+/).filter(Boolean);
  return comps.length > 0 && comps.every((c) => comparatorOk(version, c));
}
