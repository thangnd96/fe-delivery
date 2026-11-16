// Spec Kit contracts (templates/contract-tests.md) against the CLI under test.
// CI (speckit-update workflow) passes an initialised fixture in FIXTURE; locally the test
// initialises its own copy when `specify` is installed, and skips otherwise.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { featureDir } from '../../scripts/lib/run.mjs';
import { satisfies } from '../../scripts/lib/semver.mjs';
import { FIXTURE, PLUGIN_ROOT } from '../helpers.mjs';

const compat = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'compat', 'speckit.json'), 'utf8'));
const probe = spawnSync('specify', ['version'], { encoding: 'utf8' });
const available = !probe.error && probe.status === 0;
const skip = available ? false : 'specify CLI not installed';

let cached = null;
function initialised() {
  if (process.env.FIXTURE) return process.env.FIXTURE;
  if (cached) return cached;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fe-speckit-')));
  cpSync(FIXTURE, dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  execFileSync('specify', ['init', '--here', '--integration', 'claude', '--non-interactive', '--ignore-agent-tools', '--force'], { cwd: dir, stdio: 'ignore' });
  execFileSync('specify', ['extension', 'add', 'bug'], { cwd: dir, stdio: 'ignore' });
  cached = dir;
  return dir;
}

const skillFile = (dir, name) => join(dir, '.claude', 'skills', name, 'SKILL.md');
const read = (f) => readFileSync(f, 'utf8');

test('K0: installed version is inside the supported range', { skip }, () => {
  const version = (`${probe.stdout}${probe.stderr}`.match(/(\d+\.\d+\.\d+)/) || [])[1];
  assert.ok(version, 'specify version prints X.Y.Z');
  if (!process.env.SPECKIT_CANDIDATE) assert.ok(satisfies(version, compat.speckit.range), `${version} within ${compat.speckit.range}`);
});

test('K1/K2: core and bug skills exist and their frontmatter name matches the directory', { skip }, () => {
  const dir = initialised();
  const all = [...compat.speckit.required_core_skills, ...compat.speckit.required_extensions.bug];
  for (const skill of all) {
    const f = skillFile(dir, skill);
    assert.ok(existsSync(f), `${skill} installed`);
    const name = (read(f).match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1];
    assert.equal(name, skill, `${skill}: frontmatter name is what the Skill tool receives`);
  }
});

test('K3/K4: create-new-feature persists a relative feature_directory and creates spec.md', { skip }, () => {
  const dir = initialised();
  const script = join(dir, '.specify', 'scripts', 'bash', 'create-new-feature.sh');
  assert.ok(existsSync(script), 'bash create-new-feature script installed');
  const out = execFileSync('bash', [script, '--json', '--short-name', 'contract-demo', 'Contract demo feature'], { cwd: dir, encoding: 'utf8' });
  const json = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  assert.ok(json.BRANCH_NAME && json.SPEC_FILE, 'prints BRANCH_NAME and SPEC_FILE');
  const fj = JSON.parse(read(join(dir, '.specify', 'feature.json')));
  assert.ok(fj.feature_directory && !fj.feature_directory.startsWith('/'), 'feature_directory is repo-relative');
  assert.equal(featureDir(dir), join(dir, fj.feature_directory), 'fe-delivery resolves the same directory');
  assert.ok(existsSync(join(featureDir(dir), 'spec.md')), 'spec.md created in the feature directory');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(branch, 'main', 'core script does not switch branches (branch naming stays with fe-delivery)');
});

test('K5: tasks template uses markdown checkboxes', { skip }, () => {
  const dir = initialised();
  const tpl = join(dir, '.specify', 'templates', 'tasks-template.md');
  assert.ok(existsSync(tpl));
  assert.match(read(tpl), /- \[ \]/);
});

test('K6/K7/K8: implement, converge and clarify keep the behaviours fe-delivery relies on', { skip }, () => {
  const dir = initialised();
  assert.match(read(skillFile(dir, 'speckit-implement')), /proceed with implementation anyway/i, 'K6: implement stops on unchecked checklists');
  const converge = read(skillFile(dir, 'speckit-converge'));
  assert.match(converge, /append/i, 'K7: converge only appends tasks');
  assert.match(converge, /converged/i, 'K7: converge reports converged');
  assert.match(read(skillFile(dir, 'speckit-clarify')), /one question at a time/i, 'K8: clarify is interactive');
});

test('K9: integration upgrade refuses to overwrite a locally modified managed file', { skip }, () => {
  const dir = initialised();
  const f = skillFile(dir, 'speckit-plan');
  appendFileSync(f, '\n<!-- local edit by contract test -->\n');
  const res = spawnSync('specify', ['integration', 'upgrade', 'claude'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(res.status, 0, `upgrade without --force must block; output: ${res.stdout}${res.stderr}`);
  assert.match(read(f), /local edit by contract test/, 'modified file kept');
});

test('K11: the git extension is not installed by default (branches stay with fe-delivery)', { skip }, () => {
  const dir = initialised();
  assert.ok(!existsSync(join(dir, '.specify', 'extensions', 'git')), 'git extension absent after init');
});
