// Contracts P1–P8 (templates/contract-tests.md) against the pinned pilothify CLI.
// Skips when pilothify is not installed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blastRadius } from '../../scripts/lib/graph.mjs';
import { compare } from '../../scripts/lib/semver.mjs';
import { FIXTURE, PLUGIN_ROOT } from '../helpers.mjs';

const compat = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'compat', 'speckit.json'), 'utf8'));
const probe = spawnSync('pilothify', ['--version'], { encoding: 'utf8' });
const available = !probe.error && probe.status === 0;
const env = { ...process.env, PILOTHIFY_BACKEND: 'none' };

function fixtureRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fe-pilothify-')));
  cpSync(FIXTURE, dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '-A');
  g('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  return dir;
}

const run = (dir, args) => spawnSync('pilothify', args, { cwd: dir, env, encoding: 'utf8' });
const head = (dir) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
const graphOf = (dir) => JSON.parse(readFileSync(join(dir, 'pilothify-out', 'graph.json'), 'utf8'));

test('pilothify contracts P1–P8', { skip: available ? false : 'pilothify CLI not installed' }, () => {
  const version = (probe.stdout.match(/(\d+\.\d+\.\d+)/) || [])[1];
  assert.ok(version, 'P1: --version prints X.Y.Z');
  assert.ok(compare(version, compat.pilothify.min) >= 0, `P1: ${version} >= ${compat.pilothify.min}`);

  const dir = fixtureRepo();
  const extract = run(dir, ['extract', '.', '--code-only']);
  assert.equal(extract.status, 0, `P7: code-only extract works offline: ${extract.stderr}`);

  const g = graphOf(dir);
  assert.ok(Array.isArray(g.nodes) && Array.isArray(g.links), 'P4: node-link format');
  assert.ok(g.nodes.every((n) => 'id' in n), 'P4: nodes have id');
  assert.ok(g.nodes.some((n) => n.source_file === 'src/components/Button.tsx'), 'P4: nodes carry repo-relative source_file');
  assert.equal(g.built_at_commit, head(dir), 'P4: built_at_commit = HEAD');

  const allowed = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
  assert.ok(g.links.every((l) => allowed.has(l.confidence)), 'P5: confidence values');

  const fileOf = new Map(g.nodes.map((n) => [n.id, n.source_file]));
  const importEdge = g.links.find((l) => l.relation === 'imports_from' || l.relation === 'imports'
    ? fileOf.get(l.source) === 'src/features/profile/ProfileCard.tsx' && fileOf.get(l.target) === 'src/components/Button.tsx'
    : false);
  assert.ok(importEdge, 'P6: ProfileCard → Button import link has source = importer');

  const deps = blastRadius(dir, g, ['src/components/Button.tsx'], 1);
  assert.ok(deps.dependents.includes('src/features/profile/ProfileCard.tsx'), 'blast radius finds ProfileCard');
  assert.ok(deps.dependents.includes('src/features/settings/SettingsPage.tsx'), 'blast radius finds SettingsPage');

  const gods = run(dir, ['god-nodes', '--json', '--top', '3']);
  assert.equal(gods.status, 0);
  const parsed = JSON.parse(gods.stdout);
  assert.ok(Array.isArray(parsed) && parsed.every((x) => 'id' in x && 'label' in x && 'degree' in x), 'P3: god-nodes JSON shape');

  assert.equal(run(dir, ['query', 'Button']).status, 0, 'P2: query exits 0 with an answer');
  assert.equal(run(dir, ['query', 'zzqqxxnomatch']).status, 4, 'P2: query exits 4 without a match');

  writeFileSync(join(dir, 'src', 'components', 'Badge.tsx'), 'export const Badge = () => null;\n');
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'badge'], { cwd: dir });
  assert.equal(run(dir, ['update', '.']).status, 0);
  assert.equal(graphOf(dir).built_at_commit, head(dir), 'P8: update refreshes built_at_commit');
});
