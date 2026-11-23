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

// v0.4.0 contracts P9–P12: what fe-delivery's graph lifecycle relies on (pilothify 0.1.6+).
const version = (probe.stdout.match(/(\d+\.\d+\.\d+)/) || [])[1];
const lifecycle = available && version && compare(version, '0.1.6') >= 0;
const skipLifecycle = lifecycle ? false : `needs pilothify >= 0.1.6 (found ${version || 'none'})`;

test('pilothify contracts P9–P11: update --full, hooks without merge driver, commit stamp', { skip: skipLifecycle }, () => {
  const dir = fixtureRepo();
  writeFileSync(join(dir, '.gitignore'), 'pilothify-out/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'ignore'], { cwd: dir, stdio: 'ignore' });
  assert.equal(run(dir, ['extract', '.', '--code-only']).status, 0);
  const full = run(dir, ['update', '.', '--full']);
  assert.equal(full.status, 0, `P9: update --full exists: ${full.stderr}`);
  const again = run(dir, ['update', '.', '--full']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /No relevant changes/, 'P9: --full after a full build of the same tree is a no-op');
  const hooks = run(dir, ['hook', 'install', '--no-merge-driver']);
  assert.equal(hooks.status, 0, `P10: ${hooks.stderr}`);
  assert.match(hooks.stdout, /merge driver: skipped/);
  assert.throws(() => readFileSync(join(dir, '.gitattributes')), 'P10: no .gitattributes line');
  assert.match(run(dir, ['hook', 'status']).stdout, /post-checkout: installed/);
  assert.equal(run(dir, ['hook', 'uninstall', '--no-merge-driver']).status, 0);
  assert.match(run(dir, ['hook', 'status']).stdout, /post-checkout: not installed/);
  assert.equal(run(dir, ['update', '.', '--no-cluster']).status, 0);
  assert.equal(graphOf(dir).built_at_commit, head(dir), 'P11: --no-cluster stamps built_at_commit');
});

test('P12: through fe, a component added during a run is in the graph pilothify affected reads', { skip: skipLifecycle }, () => {
  const dir = fixtureRepo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fe-home-')));
  const feEnv = { ...process.env, FE_DELIVERY_HOME: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, FE_DELIVERY_NO_REFRESH: '1' };
  const fe = (...a) => spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'fe.mjs'), ...a], { cwd: dir, env: feEnv, encoding: 'utf8' });
  const ensure = fe('graph', 'ensure');
  assert.equal(ensure.status, 0, ensure.stderr);
  const full = fe('graph', 'ensure', '--full');
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /full refresh done \(pilothify update \. --full/);
  writeFileSync(join(dir, 'src', 'components', 'Badge.tsx'), 'export function Badge() { return null; }\n');
  const card = join(dir, 'src', 'features', 'profile', 'ProfileCard.tsx');
  writeFileSync(card, `import { Badge } from '../../components/Badge';\n${readFileSync(card, 'utf8')}\nexport const WithBadge = () => Badge();\n`);
  const status1 = JSON.parse(fe('graph', 'status', '--json').stdout);
  assert.equal(status1.fresh, false, 'uncommitted edits make the graph stale');
  assert.equal(fe('graph', 'ensure').status, 0);
  assert.equal(JSON.parse(fe('graph', 'status', '--json').stdout).fresh, true);
  const affected = run(dir, ['affected', 'Badge']);
  assert.equal(affected.status, 0, affected.stderr);
  assert.match(affected.stdout, /ProfileCard/);
});
