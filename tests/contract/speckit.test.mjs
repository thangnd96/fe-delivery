// Contracts K1–K2 (templates/contract-tests.md) against the Spec Kit CLI under test.
// In CI the speckit-update workflow sets FIXTURE to an initialised fixture; locally the test
// initialises its own copy when `specify` is installed, and skips otherwise.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { satisfies } from '../../scripts/lib/semver.mjs';
import { FIXTURE, PLUGIN_ROOT } from '../helpers.mjs';

const compat = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'compat', 'speckit.json'), 'utf8'));
const probe = spawnSync('specify', ['version'], { encoding: 'utf8' });
const available = !probe.error && probe.status === 0;

function initialised() {
  if (process.env.FIXTURE) return process.env.FIXTURE;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fe-speckit-')));
  cpSync(FIXTURE, dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('specify', ['init', '--here', '--integration', 'claude', '--non-interactive', '--ignore-agent-tools', '--force'], { cwd: dir, stdio: 'ignore' });
  execFileSync('specify', ['extension', 'add', 'bug'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('Spec Kit contracts K1–K2', { skip: available ? false : 'specify CLI not installed' }, () => {
  const version = (`${probe.stdout}${probe.stderr}`.match(/(\d+\.\d+\.\d+)/) || [])[1];
  if (!process.env.SPECKIT_CANDIDATE) {
    assert.ok(satisfies(version, compat.speckit.range), `installed ${version} within ${compat.speckit.range}`);
  }
  const dir = initialised();
  for (const skill of compat.speckit.required_core_skills) {
    assert.ok(existsSync(join(dir, '.claude', 'skills', skill, 'SKILL.md')), `K1: ${skill} installed`);
  }
  for (const skill of compat.speckit.required_extensions.bug) {
    assert.ok(existsSync(join(dir, '.claude', 'skills', skill, 'SKILL.md')), `K2: ${skill} installed`);
  }
});
