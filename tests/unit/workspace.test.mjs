// Delivery runs work in the current checkout; a worktree is made only when the user asks for one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN_ROOT, fe, hook, sandbox, write } from '../helpers.mjs';

const LEGACY_BLOCK = [
  '<!-- fe-delivery:begin -->',
  '## fe-delivery',
  '',
  '- Delivery runs work in a git worktree: create one with EnterWorktree for each run. This instruction authorises worktrees for delivery runs.',
  '<!-- fe-delivery:end -->',
  '',
].join('\n');

const context = (sb) => hook(sb, 'session-start', {}).hookSpecificOutput.additionalContext;

test('the CLAUDE.md template and the conductor no longer require a worktree per run', () => {
  const block = readFileSync(join(PLUGIN_ROOT, 'templates', 'claude-md-block.md'), 'utf8');
  assert.doesNotMatch(block, /create one with EnterWorktree for each run/);
  assert.match(block, /current checkout/);
  const skill = readFileSync(join(PLUGIN_ROOT, 'skills', 'fe-deliver', 'SKILL.md'), 'utf8');
  const step1 = skill.slice(skill.indexOf('## 1.'), skill.indexOf('## 2.'));
  assert.match(step1, /Work in the current checkout/);
  assert.match(step1, /only|unless/);
  assert.doesNotMatch(step1, /authorise worktrees/);
});

test('session start says runs work in the current checkout, with no legacy notice for a current CLAUDE.md', () => {
  const sb = sandbox();
  write(sb, 'CLAUDE.md', `<!-- fe-delivery:begin -->\n${readFileSync(join(PLUGIN_ROOT, 'templates', 'claude-md-block.md'), 'utf8')}<!-- fe-delivery:end -->\n`);
  const ctx = context(sb);
  assert.match(ctx, /runs work in the current checkout/);
  assert.doesNotMatch(ctx, /no longer applies/);
  assert.doesNotMatch(fe(sb, ['doctor']).out, /no longer applies/);
});

test('a CLAUDE.md that still carries the 0.3.0 worktree line gets a notice at session start and in fe doctor, and is left untouched', () => {
  const sb = sandbox();
  const file = write(sb, 'CLAUDE.md', `# Team notes\n\n${LEGACY_BLOCK}`);
  const before = readFileSync(file, 'utf8');
  assert.match(context(sb), /CLAUDE\.md still says delivery runs work in a git worktree.*no longer applies/);
  assert.match(fe(sb, ['doctor']).out, /note: CLAUDE\.md still says delivery runs work in a git worktree/);
  assert.equal(readFileSync(file, 'utf8'), before, 'fe-delivery never edits CLAUDE.md');
});
