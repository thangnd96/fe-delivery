import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blastRadius } from '../../scripts/lib/graph.mjs';

function graph() {
  const n = (id, file) => ({ id, source_file: file });
  return {
    built_at_commit: 'abc1234',
    nodes: [
      n('btn', 'packages/ui/Button.tsx'),
      n('card', 'apps/web/ProfileCard.tsx'),
      n('page', 'apps/web/SettingsPage.tsx'),
      n('app', 'apps/web/App.tsx'),
      n('maybe', 'apps/web/Maybe.tsx'),
    ],
    links: [
      { source: 'card', target: 'btn', relation: 'imports', confidence: 'EXTRACTED' },
      { source: 'page', target: 'btn', relation: 'calls', confidence: 'EXTRACTED' },
      { source: 'app', target: 'card', relation: 'imports', confidence: 'EXTRACTED' },
      { source: 'maybe', target: 'btn', relation: 'calls', confidence: 'INFERRED' },
      { source: 'btn', target: 'card', relation: 'contains', confidence: 'EXTRACTED' },
    ],
  };
}

function root() {
  const r = mkdtempSync(join(tmpdir(), 'fe-graph-'));
  mkdirSync(join(r, 'packages/ui'), { recursive: true });
  mkdirSync(join(r, 'apps/web'), { recursive: true });
  writeFileSync(join(r, 'packages/ui/package.json'), '{}');
  writeFileSync(join(r, 'apps/web/package.json'), '{}');
  return r;
}

test('blast radius walks EXTRACTED dependency links backwards', () => {
  const r = root();
  const d1 = blastRadius(r, graph(), ['packages/ui/Button.tsx'], 1);
  assert.deepEqual(d1.dependents, ['apps/web/ProfileCard.tsx', 'apps/web/SettingsPage.tsx']);
  assert.equal(d1.cross_package, true);
  assert.equal(d1.edges_counted, 'EXTRACTED');
  const d2 = blastRadius(r, graph(), ['packages/ui/Button.tsx'], 2);
  assert.equal(d2.dependent_files, 3);
  assert.ok(!d2.dependents.includes('apps/web/Maybe.tsx'), 'INFERRED edges must not count');
});

test('a file with no dependents has an empty radius', () => {
  const r = root();
  const d = blastRadius(r, graph(), ['apps/web/App.tsx'], 2);
  assert.equal(d.dependent_files, 0);
  assert.equal(d.cross_package, false);
});
