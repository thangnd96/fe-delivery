import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { FE, FIXTURE, PLUGIN_ROOT } from '../helpers.mjs';

const PROFILE = readFileSync(join(FIXTURE, '.fe-delivery', 'profile.json'), 'utf8');

// A consumer repository before fe-delivery: its own settings (4-space indent, own rules,
// sandbox deliberately off), a CLAUDE.md without trailing newline, a .gitignore, product source.
function consumerRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fe-install-')));
  const repo = join(base, 'repo');
  cpSync(FIXTURE, repo, { recursive: true });
  rmSync(join(repo, '.fe-delivery'), { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(pnpm storybook)'], deny: ['Read(./secrets/**)'] },
    sandbox: { enabled: false },
    includeCoAuthoredBy: false,
  }, null, 4));
  writeFileSync(join(repo, 'CLAUDE.md'), '# Team rules\n\nUse pnpm.');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 't');
  g('add', '-A');
  g('commit', '-qm', 'consumer repo before fe-delivery');
  const env = { ...process.env, FE_DELIVERY_HOME: join(base, 'home'), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
  const fe = (args, input) => spawnSync(process.execPath, [FE, ...args], { cwd: repo, env, input, encoding: 'utf8' });
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  return { base, repo, env, fe, git };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const commitAll = (c, msg) => {
  c.git('add', '-A');
  c.git('commit', '-qm', msg);
};

test('install then uninstall restores the repository byte for byte', () => {
  const c = consumerRepo();
  const before = snapshot(c.repo);
  const inst = c.fe(['install', '--profile', '-'], PROFILE);
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.stdout, /kept your value at sandbox\.enabled: false/);
  const settings = JSON.parse(readFileSync(join(c.repo, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('Bash(pnpm storybook)'), 'own rule kept');
  assert.ok(settings.permissions.deny.includes('Bash(claude *)'), 'fe-delivery rule added');
  assert.equal(settings.sandbox.enabled, false, 'existing value never overwritten');
  assert.ok(readFileSync(join(c.repo, 'CLAUDE.md'), 'utf8').includes('<!-- fe-delivery:begin -->'));
  commitAll(c, 'install fe-delivery');

  const installed = snapshot(c.repo);
  const dry = c.fe(['uninstall', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /restore\s+\.claude\/settings\.json/);
  assert.match(dry.stdout, /Never touched:[\s\S]*src\//);
  assert.deepEqual(snapshot(c.repo), installed, 'dry run is read-only');

  const un = c.fe(['uninstall']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.match(un.stdout, /Safety check passed/);
  assert.deepEqual(snapshot(c.repo), before, 'every file identical to before install');
  assert.equal(c.git('diff', 'HEAD~1', '--stat').trim(), '', 'working tree equals the pre-install commit');
  assert.equal(c.git('status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l && !l.includes('HEAD')).every((l) => l.startsWith(' M') || l.startsWith(' D')), true);
});

test('uninstall keeps what the team changed after install and removes only fe-delivery parts', () => {
  const c = consumerRepo();
  c.fe(['install', '--profile', '-'], PROFILE);
  commitAll(c, 'install fe-delivery');
  const srcBefore = snapshot(join(c.repo, 'src'));

  const sPath = join(c.repo, '.claude', 'settings.json');
  const s = JSON.parse(readFileSync(sPath, 'utf8'));
  s.permissions.allow.push('Bash(pnpm e2e)');
  s.env = { TEAM: '1' };
  writeFileSync(sPath, `${JSON.stringify(s, null, 2)}\n`);
  writeFileSync(join(c.repo, 'CLAUDE.md'), `${readFileSync(join(c.repo, 'CLAUDE.md'), 'utf8')}\n## Later team note\nKeep me.\n`);
  const p = JSON.parse(readFileSync(join(c.repo, '.fe-delivery', 'profile.json'), 'utf8'));
  p.jira.project_keys.push('WEB');
  writeFileSync(join(c.repo, '.fe-delivery', 'profile.json'), JSON.stringify(p, null, 2));
  commitAll(c, 'team edits after install');

  const un = c.fe(['uninstall']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  const after = JSON.parse(readFileSync(sPath, 'utf8'));
  assert.deepEqual(after.permissions.allow, ['Bash(pnpm storybook)', 'Bash(pnpm e2e)'], 'own rules kept, fe-delivery rules gone');
  assert.deepEqual(after.permissions.deny, ['Read(./secrets/**)']);
  assert.equal(after.env.TEAM, '1');
  assert.equal(after.sandbox.enabled, false);
  assert.equal(after.extraKnownMarketplaces, undefined);
  assert.equal(after.enabledPlugins, undefined);
  assert.equal(after.permissions.ask, undefined, 'array created by install is removed');
  const md = readFileSync(join(c.repo, 'CLAUDE.md'), 'utf8');
  assert.ok(!md.includes('fe-delivery'), 'fe-delivery block removed');
  assert.ok(md.includes('Later team note'), 'team edit kept');
  assert.ok(!existsSync(join(c.repo, '.fe-delivery')), '.fe-delivery removed');
  assert.deepEqual(snapshot(join(c.repo, 'src')), srcBefore, 'product source untouched');
});

test('refusals: not installed, installed twice, active run, uncommitted changes', () => {
  const c = consumerRepo();
  assert.equal(c.fe(['uninstall']).status, 1, 'no manifest');
  assert.equal(c.fe(['install', '--profile', '-'], '{"version":1}').status, 1, 'invalid profile rejected');
  assert.equal(c.fe(['install', '--profile', '-'], PROFILE).status, 0);
  assert.equal(c.fe(['install', '--profile', '-'], PROFILE).status, 1, 'second install refused');
  commitAll(c, 'install');

  writeFileSync(join(c.repo, 'CLAUDE.md'), `${readFileSync(join(c.repo, 'CLAUDE.md'), 'utf8')}\nuncommitted\n`);
  const dirty = c.fe(['uninstall']);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /uncommitted changes in CLAUDE\.md/);
  c.git('checkout', '--', 'CLAUDE.md');

  const run = c.fe(['run', 'start', '--jira', 'PROJ-1']);
  const m = run.stdout.match(/FE_RUN_STARTED (\{.*\})/);
  const post = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'hook.mjs'), 'post-tool-use'], {
    env: c.env,
    encoding: 'utf8',
    input: JSON.stringify({ cwd: c.repo, session_id: 's', tool_name: 'Bash', tool_input: { command: `node "${FE}" run start --jira PROJ-1` }, tool_response: { stdout: run.stdout } }),
  });
  assert.equal(post.status, 0);
  assert.ok(m);
  const blocked = c.fe(['uninstall']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /active runs/);
  const forced = c.fe(['uninstall', '--force-runs']);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
});

test('generated pilothify-out is removed only when it appeared after install', () => {
  const c = consumerRepo();
  c.fe(['install', '--profile', '-'], PROFILE);
  commitAll(c, 'install');
  mkdirSync(join(c.repo, 'pilothify-out'));
  writeFileSync(join(c.repo, 'pilothify-out', 'graph.json'), '{}');
  assert.equal(c.fe(['uninstall']).status, 0);
  assert.ok(!existsSync(join(c.repo, 'pilothify-out')));

  const d = consumerRepo();
  mkdirSync(join(d.repo, 'pilothify-out'));
  writeFileSync(join(d.repo, 'pilothify-out', 'graph.json'), '{"team":"graph"}');
  d.fe(['install', '--profile', '-'], PROFILE);
  commitAll(d, 'install');
  assert.equal(d.fe(['uninstall']).status, 0);
  assert.equal(readFileSync(join(d.repo, 'pilothify-out', 'graph.json'), 'utf8'), '{"team":"graph"}', 'pre-existing graph kept');
});

test('a repository with no settings, CLAUDE.md or .gitignore returns to that state', () => {
  const c = consumerRepo();
  rmSync(join(c.repo, '.claude'), { recursive: true });
  rmSync(join(c.repo, 'CLAUDE.md'));
  rmSync(join(c.repo, '.gitignore'));
  commitAll(c, 'bare repo');
  const before = snapshot(c.repo);
  assert.equal(c.fe(['install', '--profile', '-'], PROFILE).status, 0);
  commitAll(c, 'install');
  const un = c.fe(['uninstall']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.deepEqual(snapshot(c.repo), before);
  assert.ok(!existsSync(join(c.repo, '.claude')), 'directory created by install is removed');
  assert.ok(!existsSync(join(c.repo, '.fe-delivery')));
});

// v0.3.0 — found by the pilot dry run on real repositories.
test('--speckit removes exactly the unchanged files Spec Kit setup created, keeps edited ones and backups go too', () => {
  const c = consumerRepo();
  const before = snapshot(c.repo);
  // What `specify init` + `specify extension add bug` leave behind, before `fe install`.
  const sk = {
    '.specify/scripts/bash/common.sh': '#!/bin/bash\n',
    '.specify/templates/plan-template.md': '# Plan\n',
    '.specify/memory/constitution.md': '# [PROJECT] Constitution\n',
    '.specify/extensions/bug/extension.yml': 'id: bug\n',
    '.claude/skills/speckit-plan/SKILL.md': '---\nname: speckit-plan\n---\n',
  };
  for (const [p, text] of Object.entries(sk)) {
    mkdirSync(join(c.repo, p, '..'), { recursive: true });
    writeFileSync(join(c.repo, p), text);
  }
  const stub = join(c.base, 'specify-stub.sh');
  writeFileSync(stub, '#!/bin/sh\n# like `specify extension remove`: rewrites its registry and writes a backup\nmkdir -p .specify/extensions/.backup && echo saved > .specify/extensions/.backup/bug.yml\necho changed > .specify/extensions/bug/extension.yml\n', { mode: 0o755 });
  const inst = c.fe(['install', '--profile', '-', '--speckit-installed-by-setup'], PROFILE);
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.stdout, /Spec Kit footprint recorded: 5 files/);
  // The team writes its constitution (fe-setup step 5) and commits the setup.
  writeFileSync(join(c.repo, '.specify/memory/constitution.md'), '# Team constitution\n');
  commitAll(c, 'set up fe-delivery');
  const dry = c.fe(['uninstall', '--dry-run']);
  assert.match(dry.stdout, /delete the 4 unchanged files/);
  assert.match(dry.stdout, /edited files are kept: \.specify\/memory\/constitution\.md/);
  const un = spawnSync(process.execPath, [FE, 'uninstall', '--speckit'], { cwd: c.repo, env: { ...c.env, FE_DELIVERY_SPECIFY_BIN: stub }, encoding: 'utf8' });
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.match(un.stdout, /Spec Kit files created by setup: 5 removed/, 'four unchanged files plus the backup');
  assert.match(un.stdout, /KEPT \(edited after install\): \.specify\/memory\/constitution\.md/);
  const after = snapshot(c.repo);
  assert.equal(after['.specify/memory/constitution.md'] !== undefined, true);
  delete after['.specify/memory/constitution.md'];
  assert.deepEqual(after, before, 'everything else is back to the pre-install state');
});

test('reminders only: an ignored .claude/ and an Atlassian v1 endpoint are pointed out, never changed', () => {
  const c = consumerRepo();
  writeFileSync(join(c.repo, '.gitignore'), 'node_modules/\n.claude/\n');
  writeFileSync(join(c.repo, '.mcp.json'), JSON.stringify({ mcpServers: { atlassian: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' } } }, null, 2));
  commitAll(c, 'team ignores .claude/ and still uses Atlassian v1');
  const before = snapshot(c.repo);
  const gitignoreBefore = readFileSync(join(c.repo, '.gitignore'), 'utf8');
  const mcpBefore = readFileSync(join(c.repo, '.mcp.json'), 'utf8');
  const inst = c.fe(['install', '--profile', '-'], PROFILE);
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.stdout, /Note: \.claude\/settings\.json is ignored by git \(\.gitignore:2:\.claude\/\)/);
  assert.ok(readFileSync(join(c.repo, '.gitignore'), 'utf8').startsWith(gitignoreBefore), 'only the marked block is appended');
  assert.doesNotMatch(readFileSync(join(c.repo, '.gitignore'), 'utf8'), /!\.claude/, 'the team .claude/ rule is left alone');
  assert.equal(readFileSync(join(c.repo, '.mcp.json'), 'utf8'), mcpBefore, 'MCP configuration is never changed');
  const doctor = c.fe(['doctor']);
  assert.match(doctor.stdout, /deprecated v1 endpoint/);
  assert.match(doctor.stdout, /settings\.json is gitignored/);
  const session = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'hook.mjs'), 'session-start'], {
    cwd: c.repo, env: { ...c.env, FE_DELIVERY_NO_REFRESH: '1' }, input: JSON.stringify({ cwd: c.repo, session_id: 's' }), encoding: 'utf8',
  });
  assert.match(session.stdout, /mcp\.atlassian\.com\/v2\/mcp/);
  commitAll(c, 'set up fe-delivery');
  assert.equal(c.fe(['uninstall']).status, 0);
  assert.deepEqual(snapshot(c.repo), before);
});
