#!/usr/bin/env node
// fe — the CLI the fe-deliver conductor runs (inside the Bash sandbox). It writes only the
// agent zone (~/.fe-delivery/agent) and prints FE_* trailers that hooks turn into hook-zone state.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoContext } from './lib/context.mjs';
import { budgetExceeded } from './lib/diff.mjs';
import { gateMarker, GATE_IDS, maxTier, requiredGates, tierRank } from './lib/gates.mjs';
import { commonDir, head, toplevel } from './lib/git.mjs';
import { riskCategories } from './lib/glob.mjs';
import { blastRadius, graphPath, loadGraph } from './lib/graph.mjs';
import {
  activeRunsFor, applyUninstall, ignoredBy, install, legacyWorktreeLine, legacyWorktreeNotice, MANIFEST, planUninstall, readManifest,
} from './lib/install.mjs';
import { atlassianReminder, atlassianV1InProject } from './lib/mcp.mjs';
import { feCliPath, repoKey, zones } from './lib/paths.mjs';
import { buildReport } from './lib/report.mjs';
import { applyRunProfile, endConditions, gatesFor, loadRun, stopAfter } from './lib/run.mjs';
import { validateNamed } from './lib/schema.mjs';
import { agentFiles, exists, readJson, writeJson } from './lib/state.mjs';
import { trailer } from './lib/trailers.mjs';

const HELP = `fe — fe-delivery CLI
  run start --jira KEY[,KEY] [--figma URL]... [--intent feature|bug|refactor|chore|documentation] [--stop-after plan]
  run status [--json]
  run end
  intake save <file.json|->
  classify <file.json|-> [--checkpoint C1|C2|C3]
  gate question <spec|plan|override|assessment> [--summary "text"]
  verify [--levels L0,L1]
  evidence add --level L2|L3 --kind ui_smoke|visual_compare --status pass|fail|not_verified|not_run [--reason "..."] [--viewport name] [--artifact path]...
  report
  graph ensure
  profile check
  doctor
  install --profile <file.json|-> [--speckit-installed-by-setup]
  uninstall [--dry-run] [--json] [--allow-dirty] [--force-runs] [--speckit] [--machine-state]`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? true : (i += 1, next);
      if (out[key] === undefined) out[key] = value;
      else out[key] = [].concat(out[key], value);
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(msg, code = 1) {
  process.stderr.write(`fe: ${msg}\n`);
  process.exit(code);
}

function ctxOrFail() {
  const ctx = applyRunProfile(repoContext(process.cwd()));
  if (!ctx) fail('not inside a git repository with .fe-delivery/profile.json (run /fe-delivery:fe-setup)');
  if (!ctx.profile) fail(`invalid profile: ${ctx.profileErrors.join('; ')}`);
  return ctx;
}

function runOrFail(ctx) {
  if (!ctx.activeRunId) fail('no active run in this checkout (fe run start ...). If you just started one, the fe-delivery hooks may not be loaded.');
  return loadRun(ctx);
}

function readInput(src) {
  const text = !src || src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail(`input is not valid JSON: ${e.message}`);
  }
}

function list(v) {
  if (v === undefined || v === true) return [];
  return [].concat(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
}

function git(cwd, a) {
  try {
    return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// ---------------- run ----------------
function runStart(o) {
  const ctx = ctxOrFail();
  const keys = list(o.jira);
  const figma = list(o.figma);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const runId = `${(keys[0] || 'run').replace(/[^A-Za-z0-9-]/g, '')}-${stamp}`;
  const a = agentFiles(ctx.key, runId);
  const run = {
    run_id: runId,
    worktree: ctx.root,
    branch: git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    jira_keys: keys,
    figma_urls: figma,
    intent: typeof o.intent === 'string' ? o.intent : 'feature',
    stop_after: o['stop-after'] === 'plan' ? 'plan' : null,
    created_at: new Date().toISOString(),
  };
  if (o['stop-after'] !== undefined && run.stop_after !== 'plan') fail('--stop-after accepts only "plan"');
  writeJson(a.run, run);
  console.log(`Run ${runId} created for ${keys.join(', ') || 'direct request'} in ${ctx.root}`);
  const shadow = run.stop_after === 'plan' || ctx.profile.rollout?.mode === 'shadow';
  if (shadow) console.log('Shadow run: it stops after planning (no product-source edits, no implementation skills).');
  console.log('Next: run the fe-intake subagent, then `fe intake save`, then `fe classify`.');
  console.log(trailer('RUN_STARTED', { run_id: runId, worktree: ctx.root, ...(run.stop_after ? { stop_after: run.stop_after } : {}) }));
}

function status(ctx, r) {
  const { required, missing } = gatesFor(ctx, r);
  const c = r.classification;
  const diff = r.diff || { total_files: 0, total_loc: 0 };
  const remaining = endConditions(ctx, r);
  const shadow = stopAfter(ctx, r);
  return {
    run_id: r.runId,
    hooks_registered: Boolean(r.state),
    stop_after: shadow.value,
    stop_after_source: shadow.source,
    profile_frozen: Boolean(r.state?.profile),
    profile_changed_on_disk: Boolean(ctx.profileChanged),
    jira_keys: r.run?.jira_keys || [],
    tier: c?.tier || null,
    tier_floor: c?.tier_floor || null,
    risk_flags: (c?.risk_flags || []).map((f) => f.category),
    blocking_questions: c?.blocking_questions || [],
    gates_required: required,
    gates_missing: missing,
    diff: { files: diff.total_files, loc: diff.total_loc, ui_changed: Boolean(diff.ui_changed), last_edit_at: diff.last_edit_at || null },
    budget_exceeded: c ? budgetExceeded(ctx.profile, c.tier, r.diff) : null,
    evidence: r.evidence.map((e) => `${e.kind}:${e.status}@${e.finished_at}`),
    claims: r.claims.map((x) => `${x.level}/${x.kind}:${x.status}@${x.at}`),
    end_conditions_missing: remaining,
  };
}

function runStatus(o) {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const s = status(ctx, r);
  if (o.json) console.log(JSON.stringify(s, null, 2));
  else {
    for (const [k, v] of Object.entries(s)) console.log(`${k}: ${Array.isArray(v) ? v.join(', ') || '-' : typeof v === 'object' && v ? JSON.stringify(v) : v}`);
  }
}

function runEnd() {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const missing = endConditions(ctx, r);
  if (missing.length) console.log(`Not ready to end; missing:\n- ${missing.join('\n- ')}`);
  else console.log(`Requesting end of run ${r.runId}.`);
  console.log(trailer('RUN_END_REQUEST', { run_id: r.runId }));
}

// ---------------- intake / classify ----------------
function intakeSave(o) {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const data = readInput(o._[2]);
  data.run_id = r.runId;
  const errors = validateNamed('intake', data);
  if (errors.length) fail(`intake does not match intake.schema.json:\n- ${errors.join('\n- ')}`);
  writeJson(r.a.intake, data);
  const blocking = (data.open_questions || []).filter((q) => q.blocking).length;
  console.log(`Intake saved (${data.requirements.length} requirements, ${blocking} blocking questions, ${data.instructions_found_not_followed.length} instructions ignored).`);
}

function floorFromFiles(profile, count) {
  const t = profile.tiers || {};
  if (count <= (t.trivial?.max_files ?? 3)) return 'trivial';
  if (count <= (t.small?.max_files ?? 8)) return 'small';
  if (count <= (t.medium?.max_files ?? 25)) return 'medium';
  return 'large';
}

function classify(o) {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const input = readInput(o._[1]);
  const predicted = input.predicted_files || [];
  const flags = new Map();
  for (const f of input.risk_flags || []) flags.set(f.category, { ...f, source: f.source || 'jira_link' });
  for (const file of predicted) {
    for (const category of riskCategories(ctx.profile.risk?.globs, file)) {
      const f = flags.get(category) || { category, source: 'glob', matched_paths: [] };
      f.matched_paths = [...new Set([...(f.matched_paths || []), file])];
      if (!f.source) f.source = 'glob';
      flags.set(category, f);
    }
  }
  let blast = null;
  const br = ctx.profile.risk?.blast_radius;
  const graph = br ? loadGraph(ctx.root) : null;
  if (graph && predicted.length) {
    blast = blastRadius(ctx.root, graph, predicted, br.depth || 2);
    blast.threshold = br.affected_threshold;
    blast.exceeded = blast.dependent_files >= br.affected_threshold || (br.cross_package && blast.cross_package);
    if (blast.exceeded) {
      flags.set('blast_radius', {
        category: 'blast_radius',
        source: 'graph',
        detail: `${blast.dependent_files} dependent files; packages ${blast.packages.join(', ')}`,
      });
    }
    delete blast.dependents;
    delete blast.cross_package;
  }
  const isBug = input.task_type === 'bug';
  const floor = isBug ? 'bug' : floorFromFiles(ctx.profile, predicted.length);
  const modelTier = isBug ? 'bug' : input.model_tier || floor;
  let tier = isBug ? 'bug' : maxTier(modelTier, floor);
  const override = input.override ? { ...input.override } : undefined;
  if (override?.requested_tier && !isBug) {
    tier = override.requested_tier;
    override.below_floor = tierRank(tier) < tierRank(floor);
  }
  const previous = r.classification;
  const checkpoint = typeof o.checkpoint === 'string' ? o.checkpoint : previous ? 'C2' : 'C1';
  const record = {
    run_id: r.runId,
    task_type: input.task_type || 'feature',
    sources: { jira_keys: r.run?.jira_keys || [], figma_urls: r.run?.figma_urls || [] },
    checkpoint,
    size: input.size,
    model_tier: modelTier,
    tier_floor: floor,
    tier,
    floor_reasons: [`${predicted.length} predicted files`],
    risk_flags: [...flags.values()],
    blocking_questions: input.blocking_questions || [],
    predicted_files: predicted,
    history: [...(previous?.history || []), { checkpoint, tier, reason: input.reason || '', at: new Date().toISOString() }],
  };
  if (blast) {
    blast.graph_built_at_commit = blast.graph_built_at_commit || null;
    record.blast_radius = blast;
  }
  if (override) record.override = override;
  const errors = validateNamed('classification', record);
  if (errors.length) fail(`classification does not match classification.schema.json:\n- ${errors.join('\n- ')}`);
  writeJson(r.a.classification, record);
  const gates = requiredGates({ tier, flags: record.risk_flags.map((f) => f.category), belowFloor: Boolean(override?.below_floor) });
  console.log(`Tier ${tier} (model ${modelTier}, floor ${floor}). Flags: ${record.risk_flags.map((f) => f.category).join(', ') || 'none'}.`);
  console.log(`Gates required: ${gates.join(', ') || 'none'}. Blocking questions: ${record.blocking_questions.length}.`);
  if (!graph && br) console.log(`No pilothify graph at ${graphPath(ctx.root)}; blast radius not computed (run \`fe graph ensure\`).`);
}

// ---------------- gates ----------------
function gateQuestion(o) {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const gate = o._[2];
  if (!GATE_IDS.includes(gate)) fail(`unknown gate "${gate}" (${GATE_IDS.join(', ')})`);
  const summary = typeof o.summary === 'string' ? o.summary : `Approve the ${gate} for ${(r.run?.jira_keys || []).join(', ') || r.runId}?`;
  const payload = {
    questions: [{
      question: `${gateMarker(r.runId, gate)} ${summary}`,
      header: `${gate} gate`.slice(0, 12),
      multiSelect: false,
      options: [
        { label: 'Approve', description: `Continue past the ${gate} gate.` },
        { label: 'Reject', description: 'Stop here; I will give feedback.' },
      ],
    }],
  };
  console.log(JSON.stringify(payload, null, 2));
}

// ---------------- verify / evidence ----------------
function verify(o) {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const levels = list(o.levels).length ? list(o.levels) : ['L0', 'L1'];
  const checks = ctx.profile.checks || {};
  const plan = [];
  if (levels.includes('L0')) for (const k of ['typecheck', 'lint', 'build']) if (checks[k]) plan.push(['L0', k, checks[k]]);
  if (levels.includes('L1') && checks.test) plan.push(['L1', 'test', checks.test]);
  if (plan.length === 0) console.log('No checks configured for the requested levels.');
  for (const [level, kind, command] of plan) {
    const started = new Date().toISOString();
    const res = spawnSync(command, { cwd: ctx.root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const finished = new Date().toISOString();
    const code = typeof res.status === 'number' ? res.status : 1;
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    console.log(`[${level}] ${kind}: ${code === 0 ? 'pass' : 'FAIL'} (${command}, exit ${code})`);
    if (code !== 0) console.log(output.split('\n').slice(-30).join('\n'));
    console.log(trailer('EVIDENCE', {
      run_id: r.runId,
      level,
      kind,
      command,
      exit_code: code,
      status: code === 0 ? 'pass' : 'fail',
      git_sha: head(ctx.root) || 'unknown',
      started_at: started,
      finished_at: finished,
      output_excerpt: output.slice(-1500),
    }));
  }
}

function evidenceAdd(o) {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const claim = {
    level: o.level,
    kind: o.kind,
    status: o.status,
    reason: typeof o.reason === 'string' ? o.reason : undefined,
    viewport: typeof o.viewport === 'string' ? o.viewport : undefined,
    artifacts: list(o.artifact),
    at: new Date().toISOString(),
  };
  Object.keys(claim).forEach((k) => claim[k] === undefined && delete claim[k]);
  const errors = validateNamed('claim', claim);
  if (errors.length) fail(`claim does not match claim.schema.json:\n- ${errors.join('\n- ')}`);
  const claims = readJson(r.a.claims, []);
  claims.push(claim);
  writeJson(r.a.claims, claims);
  console.log(`Recorded ${claim.level}/${claim.kind}: ${claim.status}.`);
}

// ---------------- report / graph / profile / doctor ----------------
function report() {
  const ctx = ctxOrFail();
  const r = runOrFail(ctx);
  const md = buildReport(ctx, r);
  mkdirSync(dirname(r.a.report), { recursive: true });
  writeFileSync(r.a.report, md);
  console.log(md);
}

function graphEnsure() {
  const ctx = ctxOrFail();
  const env = { ...process.env, PILOTHIFY_BACKEND: 'none' };
  const hasGraph = exists(graphPath(ctx.root));
  const cmd = hasGraph ? ['update', '.'] : ['extract', '.', '--code-only'];
  const res = spawnSync('pilothify', cmd, { cwd: ctx.root, env, encoding: 'utf8' });
  if (res.error) fail(`pilothify not available (${res.error.code}). Install: see compat/speckit.json`);
  const g = loadGraph(ctx.root);
  const at = g?.built_at_commit || null;
  console.log(`pilothify ${cmd.join(' ')} → exit ${res.status}; built_at_commit ${at || '?'}; HEAD ${head(ctx.root)}`);
  if (res.status !== 0) console.log((res.stderr || res.stdout || '').split('\n').slice(-20).join('\n'));
}

function profileCheck() {
  const ctx = repoContext(process.cwd());
  if (!ctx) fail('no .fe-delivery/profile.json in this repository');
  if (ctx.profileErrors.length) fail(`profile invalid:\n- ${ctx.profileErrors.join('\n- ')}`);
  console.log('profile ok');
}

function doctor() {
  const ctx = repoContext(process.cwd());
  const v = (cmd, a) => {
    const res = spawnSync(cmd, a, { encoding: 'utf8' });
    return res.error ? 'not found' : (`${res.stdout}${res.stderr}`.match(/\d+\.\d+\.\d+/) || ['?'])[0];
  };
  console.log(`node ${process.versions.node}`);
  console.log(`git ${v('git', ['--version'])}`);
  console.log(`specify ${v('specify', ['version'])}`);
  console.log(`pilothify ${v('pilothify', ['--version'])}`);
  console.log(`fe CLI: node "${feCliPath()}"`);
  if (!ctx) {
    console.log('repository: no .fe-delivery/profile.json');
    return;
  }
  console.log(`repository: ${ctx.root}`);
  console.log(`profile: ${ctx.profile ? 'ok' : `INVALID (${ctx.profileErrors.join('; ')})`}`);
  const settings = readJson(join(ctx.root, '.claude', 'settings.json'), null);
  console.log(`.claude/settings.json: ${settings ? 'present' : 'missing'}`);
  if (settings) {
    const deny = settings.permissions?.deny || [];
    for (const rule of ['Bash(claude *)', 'Bash(specify workflow run *)', 'Read(.env)']) {
      console.log(`  deny ${rule}: ${deny.includes(rule) ? 'yes' : 'MISSING'}`);
    }
    console.log(`  sandbox.enabled: ${settings.sandbox?.enabled === true ? 'yes' : 'no (hook-zone protection is weaker)'}`);
  }
  const ignored = ignoredBy(ctx.root, ['.fe-delivery/profile.json', '.claude/settings.json', '.claude/skills/speckit-specify/SKILL.md']);
  for (const [path, rule] of Object.entries(ignored)) console.log(`note: ${path} is gitignored (${rule}); it does not reach teammates through the repository`);
  if (atlassianV1InProject(ctx.root)) console.log(`note: ${atlassianReminder().replace(/^Reminder: /, '')}`);
  if (legacyWorktreeLine(ctx.root)) console.log(`note: ${legacyWorktreeNotice()}`);
  console.log(`rollout: ${ctx.profile?.rollout?.mode || 'full'}`);
  const g = loadGraph(ctx.root);
  console.log(`graph: ${g ? `built_at_commit ${g.built_at_commit} (HEAD ${head(ctx.root)})` : 'missing'}`);
  console.log(`active run: ${ctx.activeRunId || 'none'}`);
}

// ---------------- install / uninstall ----------------
function gitRootOrFail() {
  const root = toplevel(process.cwd());
  if (!root) fail('not inside a git repository');
  return root;
}

function installCmd(o) {
  const root = gitRootOrFail();
  if (!o.profile) fail('install needs --profile <file.json|-> (fe-setup prepares it)');
  const profileText = o.profile === true || o.profile === '-' ? readFileSync(0, 'utf8') : readFileSync(o.profile, 'utf8');
  let profile;
  try {
    profile = JSON.parse(profileText);
  } catch (e) {
    fail(`profile is not valid JSON: ${e.message}`);
  }
  const errors = validateNamed('profile', profile);
  if (errors.length) fail(`profile does not match profile.schema.json:\n- ${errors.join('\n- ')}`);
  let manifest;
  try {
    manifest = install(root, {
      profileText: `${JSON.stringify(profile, null, 2)}\n`,
      speckitInstalledBySetup: o['speckit-installed-by-setup'] === true,
    });
  } catch (e) {
    fail(e.message);
  }
  for (const op of manifest.operations) {
    const extra = op.op === 'json-merge' ? ` (${op.records.length} entries added)` : op.reason ? ` (${op.reason})` : '';
    console.log(`${op.op.padEnd(12)} ${op.path}${extra}`);
    for (const c of op.conflicts || []) {
      console.log(`  kept your value at ${c.path.join('.')}: ${JSON.stringify(c.kept)} (fe-delivery suggests ${JSON.stringify(c.wanted)})`);
    }
  }
  if (manifest.speckit_files.length) console.log(`Spec Kit footprint recorded: ${manifest.speckit_files.length} files (removed by \`fe uninstall --speckit\` while unchanged).`);
  for (const w of manifest.warnings || []) console.log(`Note: ${w}`);
  console.log(`\nRecorded in ${MANIFEST}. Commit these files together; \`fe uninstall\` reverts exactly this footprint.`);
}

function uninstallCmd(o) {
  const root = gitRootOrFail();
  const manifest = readManifest(root);
  if (!manifest) {
    fail(`no ${MANIFEST} in ${root}. fe-delivery was not installed with \`fe install\`; see the uninstall guide for manual removal.`);
  }
  const common = commonDir(root) || join(root, '.git');
  const key = repoKey(common);
  const runs = activeRunsFor(join(zones.hook(key), 'active.json'));
  const paths = manifest.operations.filter((op) => op.op !== 'skip').map((op) => op.path);
  const dirty = paths.length ? git(root, ['diff', '--name-only', 'HEAD', '--', ...paths]).split('\n').filter(Boolean) : [];
  const plan = planUninstall(root, manifest);
  const machine = [zones.agent(key), zones.hook(key)];

  if (o['dry-run']) {
    if (o.json) {
      console.log(JSON.stringify({ root, installed_version: manifest.fe_delivery_version, active_runs: runs, uncommitted_manifest_paths: dirty, ...plan, machine_state: machine }, null, 2));
      return;
    }
    console.log(`fe-delivery ${manifest.fe_delivery_version} installed ${manifest.installed_at} in ${root}\n`);
    console.log('Plan (only these paths change):');
    for (const s of plan.steps) console.log(`  ${s.action.padEnd(15)} ${s.path} — ${s.why}`);
    console.log('\nNever touched:');
    for (const u of plan.untouched) console.log(`  - ${u}`);
    for (const opt of plan.optional) console.log(`\nOptional ${opt.flag}: ${opt.why} → ${opt.commands.join(' ; ')}`);
    console.log(`\nMachine state for this repository (removed with --machine-state):\n  ${machine.join('\n  ')}`);
    if (runs.length) console.log(`\nBLOCKER: active runs in ${runs.map(([w]) => w).join(', ')} (finish them with \`fe run end\`, or pass --force-runs; worktrees are never deleted).`);
    if (dirty.length) console.log(`\nBLOCKER: uncommitted changes in ${dirty.join(', ')} (commit or stash them, or pass --allow-dirty).`);
    return;
  }
  if (runs.length && !o['force-runs']) fail(`active runs in ${runs.map(([w]) => w).join(', ')}; finish them (\`fe run end\`) or pass --force-runs`);
  if (dirty.length && !o['allow-dirty']) fail(`uncommitted changes in ${dirty.join(', ')}; commit them first so the uninstall diff is reviewable, or pass --allow-dirty`);

  const { report, violations } = applyUninstall(root, manifest, { speckit: o.speckit === true });
  for (const line of report) console.log(line);
  if (o['machine-state']) {
    for (const dir of machine) {
      try {
        rmSync(dir, { recursive: true, force: true });
        console.log(`${dir}: deleted`);
      } catch (e) {
        console.log(`${dir}: NOT deleted (${e.code || e.message}); run this command outside the Claude Code sandbox`);
      }
    }
  }
  if (violations.length) {
    console.log(`\nSAFETY CHECK FAILED: paths outside the install manifest changed: ${violations.join(', ')}`);
    process.exit(2);
  }
  console.log('\nSafety check passed: only paths from the install manifest changed.');
  console.log('Next: review `git status` / `git diff`, commit, then remove the plugin:');
  console.log('  claude plugin uninstall fe-delivery@piloth-marketplace --scope project');
}

// ---------------- main ----------------
const o = args(process.argv.slice(2));
const [a0, a1] = o._;
const cmd = [a0, a1].filter(Boolean).join(' ');
switch (true) {
  case cmd === 'run start': runStart(o); break;
  case cmd === 'run status': runStatus(o); break;
  case cmd === 'run end': runEnd(o); break;
  case cmd === 'intake save': intakeSave(o); break;
  case a0 === 'classify': classify(o); break;
  case cmd === 'gate question': gateQuestion(o); break;
  case a0 === 'verify': verify(o); break;
  case cmd === 'evidence add': evidenceAdd(o); break;
  case a0 === 'report': report(o); break;
  case cmd === 'graph ensure': graphEnsure(o); break;
  case cmd === 'profile check': profileCheck(o); break;
  case a0 === 'doctor': doctor(o); break;
  case a0 === 'install': installCmd(o); break;
  case a0 === 'uninstall': uninstallCmd(o); break;
  default: console.log(HELP);
}
