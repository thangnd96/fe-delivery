// Run through tests/fixtures/bin/pilothify (a sh wrapper): Node 18 cannot run an extensionless ES module.
// Test double for the pilothify CLI. It records every call and imitates the parts of
// pilothify 0.1.6 that fe-delivery uses, so unit tests stay fast and need no Python.
//   FE_STUB_PILOTHIFY_LOG      JSONL file that receives {argv, cwd, at, backend} per call
//   FE_STUB_PILOTHIFY_VERSION  reported version (default 0.1.6; < 0.1.6 lacks --full and --no-merge-driver)
//   FE_STUB_PILOTHIFY_MODE     ok (default) | refuse (exit 1) | refuse0 (refusal text, exit 0) | fail
//                              | traceback (a Python traceback ending in PermissionError, exit 1)
//                              | killed (progress output, then SIGKILL)
//   FE_STUB_PILOTHIFY_SLEEP_MS delay inside update/extract, holding pilothify-out/.rebuild.lock
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const cwd = process.cwd();
const version = process.env.FE_STUB_PILOTHIFY_VERSION || '0.1.6';
const mode = process.env.FE_STUB_PILOTHIFY_MODE || 'ok';
const out = join(cwd, process.env.PILOTHIFY_OUT || 'pilothify-out');
if (process.env.FE_STUB_PILOTHIFY_LOG) {
  appendFileSync(process.env.FE_STUB_PILOTHIFY_LOG, `${JSON.stringify({
    argv, cwd, at: new Date().toISOString(), backend: process.env.PILOTHIFY_BACKEND || null,
  })}\n`);
}
const newer = (() => {
  const [a, b, c] = version.split('.').map(Number);
  return a > 0 || b > 1 || c >= 6;
})();
const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const idOf = (rel) => rel.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();

function writeGraph() {
  const files = git('ls-files', '-co', '--exclude-standard').split('\n')
    .filter((f) => /\.(tsx?|jsx?)$/.test(f) && !f.startsWith('pilothify-out/'));
  const nodes = [];
  const links = [];
  for (const f of files) {
    nodes.push({ id: idOf(f), label: f.split('/').pop(), source_file: f });
    let text = '';
    try {
      text = readFileSync(join(cwd, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/export (?:const|function|class) ([A-Za-z0-9_]+)/g)) {
      nodes.push({ id: `${idOf(f)}_${m[1].toLowerCase()}`, label: m[1], source_file: f });
      links.push({ source: idOf(f), target: `${idOf(f)}_${m[1].toLowerCase()}`, relation: 'contains', confidence: 'EXTRACTED' });
    }
  }
  mkdirSync(out, { recursive: true });
  const graph = { directed: true, nodes, links };
  const head = git('rev-parse', 'HEAD');
  if (head) graph.built_at_commit = head;
  writeFileSync(join(out, 'graph.json'), JSON.stringify(graph));
  return graph;
}

function rebuild() {
  if (mode === 'fail') {
    process.stderr.write('pilothify stub: rebuild failed\n');
    process.exit(1);
  }
  if (mode === 'traceback') {
    process.stdout.write('[pilothify] scanning 3 files\n');
    process.stderr.write([
      'Traceback (most recent call last):',
      '  File "/opt/pilothify/lib/python3.13/site-packages/pilothify/cli.py", line 4750, in main',
      '    run_update(args)',
      '  File "/opt/pilothify/lib/python3.13/site-packages/pilothify/watch.py", line 2412, in run_update',
      '    with lock_path.open("w") as fh:',
      "PermissionError: [Errno 1] Operation not permitted: '/Users/dev/.cache/pilothify/state/a-rather-long-directory-name/graph.lock'",
      '',
    ].join('\n'));
    process.exit(1);
  }
  if (mode === 'killed') {
    writeFileSync(1, '[pilothify] parsing src/utils/error.ts\n[pilothify] parsing src/utils/format.ts\n');
    process.kill(process.pid, 'SIGKILL');
  }
  if (mode === 'refuse' || mode === 'refuse0') {
    process.stderr.write('[pilothify] WARNING: Refusing to overwrite — rebuild has 3 nodes but existing graph.json has 9.\n');
    process.exit(mode === 'refuse' ? 1 : 0);
  }
  const lock = join(out, '.rebuild.lock');
  mkdirSync(out, { recursive: true });
  writeFileSync(lock, `${process.pid}\n`);
  try {
    const ms = Number(process.env.FE_STUB_PILOTHIFY_SLEEP_MS || 0);
    if (ms > 0) sleep(ms);
    const g = writeGraph();
    console.log(`[pilothify watch] Rebuilt: ${g.nodes.length} nodes, ${g.links.length} edges`);
  } finally {
    rmSync(lock, { force: true });
  }
}

const HOOKS = {
  'post-commit': '# pilothify-hook-start',
  'post-checkout': '# pilothify-checkout-hook-start',
  'post-merge': '# pilothify-merge-hook-start',
  'post-rewrite': '# pilothify-rewrite-hook-start',
};
function hooksDir() {
  const raw = git('rev-parse', '--git-path', 'hooks');
  const dir = raw.startsWith('/') ? raw : join(cwd, raw);
  return dir.endsWith('/_') ? dir.slice(0, -2) : dir;
}

const [cmd, sub] = argv;
if (cmd === '--version') {
  console.log(`pilothify ${version}`);
} else if (cmd === 'update') {
  const opts = argv.slice(1).filter((a) => a.startsWith('-'));
  for (const o of opts) {
    if (!['--force', '--no-cluster', ...(newer ? ['--full'] : [])].includes(o)) {
      process.stderr.write(`error: unknown update option: ${o}\n`);
      process.exit(2);
    }
  }
  console.log('Updating code graph in . (no LLM needed)...');
  rebuild();
  console.log('Code graph updated.');
} else if (cmd === 'extract') {
  rebuild();
} else if (cmd === 'hook') {
  const opts = argv.slice(2);
  if (opts.some((o) => o !== '--no-merge-driver') || (opts.length && !newer)) {
    process.stderr.write(`error: unknown hook ${sub} option: ${opts[0]}\n`);
    process.exit(2);
  }
  const dir = hooksDir();
  const lines = [];
  for (const [name, marker] of Object.entries(HOOKS)) {
    const file = join(dir, name);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const end = marker.replace('-start', '-end');
    if (sub === 'install') {
      mkdirSync(dir, { recursive: true });
      if (!text.includes(marker)) writeFileSync(file, `${text || '#!/bin/sh\n'}${marker}\necho rebuild\n${end}\n`, { mode: 0o755 });
      lines.push(`${name}: installed at ${file}`);
    } else if (sub === 'uninstall') {
      if (text.includes(marker)) {
        const kept = text.replace(new RegExp(`${marker}[\\s\\S]*?${end}\\n?`), '');
        if (kept.trim() === '#!/bin/sh' || !kept.trim()) rmSync(file);
        else writeFileSync(file, kept);
        lines.push(`${name}: removed`);
      } else lines.push(`${name}: nothing to remove`);
    } else {
      lines.push(`${name}: ${text.includes(marker) ? 'installed' : 'not installed'}`);
    }
  }
  lines.push(`merge driver: ${opts.includes('--no-merge-driver') ? 'skipped (--no-merge-driver)' : 'registered'}`);
  console.log(lines.join('\n'));
} else if (cmd === 'query' || cmd === 'explain' || cmd === 'affected' || cmd === 'path') {
  const q = argv.slice(1).find((a) => !a.startsWith('-')) || '';
  if (/^zz/.test(q)) process.exit(4);
  console.log(`stub answer for ${cmd} ${q}`);
} else {
  process.stderr.write(`pilothify stub: unsupported ${argv.join(' ')}\n`);
  process.exit(2);
}
