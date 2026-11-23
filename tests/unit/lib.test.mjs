import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { requiredGates } from '../../scripts/lib/gates.mjs';
import { matchGlob, riskCategories } from '../../scripts/lib/glob.mjs';
import { loadSchema, validate } from '../../scripts/lib/schema.mjs';
import { compare, satisfies } from '../../scripts/lib/semver.mjs';
import { programOf, simpleCommands } from '../../scripts/lib/shell.mjs';
import { isFeCliCommand, parseTrailers, tokenize } from '../../scripts/lib/trailers.mjs';
import { bashViolation } from '../../scripts/rules/pre.mjs';
import { parsePrompt } from '../../scripts/rules/prompt.mjs';
import { FE, PLUGIN_ROOT } from '../helpers.mjs';

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;

test('glob: anchored, basename and ** semantics', () => {
  assert.ok(matchGlob('src/**/auth/**', 'src/auth/guard.ts'));
  assert.ok(matchGlob('src/**/auth/**', 'src/a/b/auth/x/y.ts'));
  assert.ok(!matchGlob('src/**/auth/**', 'lib/auth/guard.ts'));
  assert.ok(matchGlob('package.json', 'packages/web/package.json'));
  assert.ok(matchGlob('tailwind.config.*', 'tailwind.config.ts'));
  assert.ok(matchGlob('.env*', 'apps/web/.env.local'));
  assert.ok(matchGlob('src/**/*.css', 'src/styles/app.css'));
  assert.ok(matchGlob('*.{ts,tsx}', 'src/a.tsx'));
  assert.ok(!matchGlob('src/App.tsx', 'src/features/App.tsx'));
  assert.deepEqual(riskCategories({ auth: ['src/**/auth/**'], deps: ['package.json'] }, 'src/auth/x.ts'), ['auth']);
});

test('semver: compare and ranges', () => {
  assert.equal(compare('1.4.0', '1.4.0'), 0);
  assert.equal(compare('1.10.0', '1.9.9'), 1);
  assert.ok(satisfies('1.4.3', '>=1.4.0 <1.5.0'));
  assert.ok(!satisfies('1.5.0', '>=1.4.0 <1.5.0'));
  assert.ok(satisfies('0.1.9', '^0.1.5'));
  assert.ok(!satisfies('0.2.0', '^0.1.5'));
  assert.ok(satisfies('1.4.9', '~1.4.0'));
  assert.ok(!satisfies('garbage', '>=1.0.0'));
});

test('the profile template pins the Spec Kit and pilothify that fe-setup installs', () => {
  // fe-setup installs compat's tested versions, then drafts the profile from this template;
  // a template pin behind compat makes a new repo look outdated on its first session.
  const profile = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'templates', 'profile.example.json'), 'utf8'));
  const compat = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'compat', 'speckit.json'), 'utf8'));
  assert.equal(profile.versions.speckit, compat.speckit.tested);
  assert.equal(profile.versions.pilothify, compat.pilothify.tested);
  assert.ok(compat.speckit.install.endsWith(`specify-cli==${compat.speckit.tested}`), compat.speckit.install);
  assert.ok(compat.pilothify.install.endsWith(`@v${compat.pilothify.tested}"`), compat.pilothify.install);
  assert.ok(satisfies(compat.pilothify.tested, `>=${compat.pilothify.min}`));
});

test('schemas are well-formed and accept the documented examples', () => {
  const profile = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'templates', 'profile.example.json'), 'utf8'));
  assert.deepEqual(validate(loadSchema('profile'), profile), []);
  const fixtureProfile = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tests/fixtures/fe-app/.fe-delivery/profile.json'), 'utf8'));
  assert.deepEqual(validate(loadSchema('profile'), fixtureProfile), []);
  const bad = { ...profile, jira: { project_keys: ['bad-key'] } };
  assert.ok(validate(loadSchema('profile'), bad).length > 0);
  const claim = { level: 'L2', kind: 'ui_smoke', status: 'not_verified', at: 'x' };
  assert.ok(validate(loadSchema('claim'), claim).some((e) => e.includes('reason')));
  assert.deepEqual(validate(loadSchema('claim'), { ...claim, reason: 'no mocks' }), []);
});

test('prompt parsing only matches configured Jira keys', () => {
  const p = parsePrompt('Implement PROJ-12 and PROJ-7, not UTF-8 or ISO-8601. https://www.figma.com/design/AbC123/App?node-id=1-2&t=x [tier:small]', ['PROJ']);
  assert.deepEqual(p.jira_keys.sort(), ['PROJ-12', 'PROJ-7']);
  assert.equal(p.figma_urls.length, 1);
  assert.ok(p.figma_urls[0].includes('node-id=1-2'));
  assert.deepEqual(p.overrides, { tier: 'small' });
  assert.equal(parsePrompt('fix it [no-run]', ['PROJ']).no_run, true);
});

test('fe CLI command recognition rejects chaining and substitution', () => {
  assert.ok(isFeCliCommand(`node "${FE}" verify`, ['verify']));
  assert.ok(isFeCliCommand(`node ${FE} run start --jira PROJ-1 --figma "https://figma.com/design/x?a=1&b=2"`, ['run start']));
  assert.ok(!isFeCliCommand(`node "${FE}" verify; echo FE_EVIDENCE {}`, ['verify']));
  assert.ok(!isFeCliCommand(`node "${FE}" verify && echo hi`, ['verify']));
  assert.ok(!isFeCliCommand(`node "${FE}" verify $(echo x)`, ['verify']));
  assert.ok(!isFeCliCommand(`node "${FE}" verify > out.txt`, ['verify']));
  assert.ok(!isFeCliCommand(`node /tmp/fake/fe.mjs verify`, ['verify']));
  assert.equal(tokenize('a "b c" \'d\'').length, 3);
  assert.equal(tokenize('a | b'), null);
  assert.deepEqual(parseTrailers('x\nFE_EVIDENCE {"a":1}\nFE_BAD {oops}').map((t) => t.kind), ['EVIDENCE']);
});

test('bash guard: nested claude, workflow engine, bypass flag, hook zone', () => {
  assert.ok(bashViolation('claude -p "/fe-approve"'));
  assert.ok(bashViolation('cd x && claude --version'));
  assert.ok(bashViolation('FOO=1 npx @anthropic-ai/claude-code -p hi'));
  assert.ok(bashViolation('specify workflow run speckit'));
  assert.ok(bashViolation('specify workflow resume abc --input verdict=approve'));
  assert.ok(bashViolation('pnpm test -- --dangerously-skip-permissions'));
  assert.ok(bashViolation('cat ~/.fe-delivery/hook/x/runs/y/approvals.json'));
  assert.equal(bashViolation('grep -rn claude src'), null);
  assert.equal(bashViolation('cat CLAUDE.md'), null);
  assert.equal(bashViolation('specify version'), null);
  assert.equal(bashViolation('pnpm typecheck'), null);
});

test('shell helpers find the real program', () => {
  assert.deepEqual(simpleCommands('a; b && c | d').length, 4);
  assert.equal(programOf('FOO=1 sudo -E claude -p x').program, 'claude');
  assert.equal(programOf('/usr/local/bin/claude').program, 'claude');
  assert.equal(programOf('pnpm test --run').program, 'pnpm');
  assert.equal(programOf('pnpm dlx claude').program, 'claude');
});

test('required gates follow tier and risk', () => {
  assert.deepEqual(requiredGates({ tier: 'small' }), []);
  assert.deepEqual(requiredGates({ tier: 'small', flags: ['auth'] }), ['plan']);
  assert.deepEqual(requiredGates({ tier: 'medium' }), ['plan']);
  assert.deepEqual(requiredGates({ tier: 'large' }).sort(), ['plan', 'spec']);
  assert.deepEqual(requiredGates({ tier: 'trivial', observedRisk: ['auth'] }), ['plan']);
  assert.deepEqual(requiredGates({ tier: 'bug' }), []);
  assert.deepEqual(requiredGates({ tier: 'bug', flags: ['auth'] }), ['assessment']);
  assert.deepEqual(requiredGates({ tier: 'small', belowFloor: true }), ['override']);
});
