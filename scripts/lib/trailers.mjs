// The fe CLI prints machine-readable trailer lines. Hooks trust them only when the Bash
// command is exactly an fe CLI call (no chaining, redirection or substitution), so the
// model cannot fake a trailer with `echo`.
import { realpathSync } from 'node:fs';
import { feCliPath } from './paths.mjs';

export function trailer(kind, data) {
  return `FE_${kind} ${JSON.stringify(data)}`;
}

export function parseTrailers(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^FE_([A-Z_]+) (\{.*\})\s*$/);
    if (!m) continue;
    try {
      out.push({ kind: m[1], data: JSON.parse(m[2]) });
    } catch {
      // ignore malformed trailer
    }
  }
  return out;
}

// Shell-like tokenizer that returns null when the command contains anything beyond plain
// words and quoted strings (unquoted ; & | ` $ < > ( ) { } \ or newline, or $ / ` inside "").
export function tokenize(command) {
  const cmd = String(command || '');
  const tokens = [];
  let cur = '';
  let inToken = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += cmd.slice(i + 1, end);
      inToken = true;
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '$' || cmd[j] === '`') return null;
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          s += cmd[j + 1];
          j += 2;
          continue;
        }
        s += cmd[j];
        j += 1;
      }
      if (j >= cmd.length) return null;
      cur += s;
      inToken = true;
      i = j + 1;
    } else if (/\s/.test(ch)) {
      if (ch === '\n') return null;
      if (inToken) {
        tokens.push(cur);
        cur = '';
        inToken = false;
      }
      i += 1;
    } else if (/[;&|`$<>(){}\\]/.test(ch)) {
      return null;
    } else {
      cur += ch;
      inToken = true;
      i += 1;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

function cliPaths() {
  const p = feCliPath();
  const set = new Set([p]);
  try {
    set.add(realpathSync(p));
  } catch {
    // keep the configured path only
  }
  return [...set];
}

// True when `command` is `node <fe.mjs> <subcommand> [plain args]` and nothing else.
export function isFeCliCommand(command, subcommands) {
  const tokens = tokenize(String(command || '').trim());
  if (!tokens || tokens.length < 3) return false;
  if (tokens[0] !== 'node' && !/\/node$/.test(tokens[0])) return false;
  if (!cliPaths().includes(tokens[1])) return false;
  return subcommands.some((sub) => {
    const words = sub.split(' ');
    return words.every((w, i) => tokens[2 + i] === w);
  });
}

export function bashStdout(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse.stdout === 'string') return toolResponse.stdout;
  if (typeof toolResponse.output === 'string') return toolResponse.output;
  return '';
}
