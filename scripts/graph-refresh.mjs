#!/usr/bin/env node
// Background graph refresh, started (detached) by the PostToolUse hook after a git command
// changed the working tree: node graph-refresh.mjs <checkout root>
// It waits a moment so that a rebuild pilothify's own git hook launched takes the lock first
// (`pilothify update` then waits for it and finds little left to do), runs `pilothify update`,
// and records fe's freshness stamp when the update succeeded. Output: <out>/fe-refresh.log.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoContext } from './lib/context.mjs';
import { graphFile, outDir, worktreeStamp, writeStamp } from './lib/freshness.mjs';
import { graphCounts, runPilothify } from './lib/pilothify.mjs';

const root = process.argv[2];
const delay = Number(process.env.FE_GRAPH_REFRESH_DELAY_MS ?? 1500);
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);

function log(line) {
  try {
    mkdirSync(outDir(root), { recursive: true });
    appendFileSync(join(outDir(root), 'fe-refresh.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best effort
  }
}

if (root && existsSync(graphFile(root))) {
  const ctx = repoContext(root);
  const before = worktreeStamp(root);
  const res = runPilothify(root, ['update', '.']);
  const output = `${res.stdout}\n${res.stderr}`;
  const ok = !res.error && res.status === 0 && !/refusing to overwrite/i.test(output);
  if (ok && ctx) {
    const counts = graphCounts(root);
    writeStamp(ctx.key, root, {
      head: before.head, fingerprint: before.fingerprint, unreadable: before.unreadable,
      mode: 'incremental', at: new Date().toISOString(), exit: 0, nodes: counts.nodes, edges: counts.edges,
    });
  }
  log(`pilothify update . → ${res.error ? res.error.code : `exit ${res.status}`}${ok ? '' : ` ${output.trim().split('\n').slice(-3).join(' | ')}`}`);
}
