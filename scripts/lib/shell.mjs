// Lenient shell splitting used only for *detection* (never for execution):
// splits on unquoted ; && || | & and newlines, then reads the leading words.
export function simpleCommands(command) {
  const cmd = String(command || '');
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function words(simple) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(simple))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const WRAPPERS = new Set(['sudo', 'env', 'exec', 'command', 'nohup', 'time', 'xargs', 'npx', 'pnpm', 'yarn', 'bunx', 'nice']);

// The program actually run by a simple command, skipping env assignments and common wrappers.
export function programOf(simple) {
  const w = words(simple);
  let i = 0;
  while (i < w.length) {
    const word = w[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    if (WRAPPERS.has(word)) {
      i += 1;
      if (word === 'pnpm' || word === 'yarn') {
        if (w[i] === 'dlx' || w[i] === 'exec') i += 1;
        else return { program: word, args: w.slice(i) };
      }
      while (i < w.length && w[i].startsWith('-')) i += 1;
      continue;
    }
    const program = word.split('/').pop();
    return { program, args: w.slice(i + 1) };
  }
  return { program: null, args: [] };
}
