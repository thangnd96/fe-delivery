#!/usr/bin/env node
// Single hook entry point: node hook.mjs <session-start|user-prompt-submit|pre-tool-use|post-tool-use|stop|refresh-versions>
// Hooks are no-ops outside repositories that contain .fe-delivery/profile.json.
// PreToolUse fails closed inside fe-delivery repositories (hooks.json also sets onFailure: block).
import { execFileSync } from 'node:child_process';
import { repoContext } from './lib/context.mjs';
import { denyTool, emit, readHookInput } from './lib/io.mjs';
import { writeJson } from './lib/state.mjs';
import { onPostToolUse } from './rules/post.mjs';
import { onPreToolUse } from './rules/pre.mjs';
import { onUserPromptSubmit } from './rules/prompt.mjs';
import { cacheFile, onSessionStart } from './rules/session.mjs';
import { onStop } from './rules/stop.mjs';

const HANDLERS = {
  'session-start': onSessionStart,
  'user-prompt-submit': onUserPromptSubmit,
  'pre-tool-use': onPreToolUse,
  'post-tool-use': onPostToolUse,
  stop: onStop,
};

function version(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return { raw: out.trim().slice(0, 500), version: m ? m[1] : null };
  } catch {
    return { raw: null, version: null };
  }
}

function refreshVersions() {
  const speckit = version('specify', ['version']);
  const check = version('specify', ['self', 'check']);
  const pilothify = version('pilothify', ['--version']);
  const latest = check.raw ? [...check.raw.matchAll(/(\d+\.\d+\.\d+)/g)].map((m) => m[1]) : [];
  writeJson(cacheFile(), {
    at: new Date().toISOString(),
    speckit: speckit.version,
    speckit_latest: latest.length ? latest[latest.length - 1] : null,
    speckit_self_check: check.raw,
    pilothify: pilothify.version,
  });
}

function main() {
  const event = process.argv[2];
  if (event === 'refresh-versions') {
    refreshVersions();
    return;
  }
  const handler = HANDLERS[event];
  if (!handler) return;
  const input = readHookInput();
  let ctx = null;
  try {
    ctx = repoContext(input.cwd || process.cwd());
    const out = handler(input, ctx);
    if (out) emit(out);
  } catch (err) {
    if (event === 'pre-tool-use' && ctx?.profile) {
      emit(denyTool(`guard error, failing closed: ${err?.message || err}`));
      return;
    }
    process.stderr.write(`fe-delivery ${event} hook error: ${err?.stack || err}\n`);
  }
}

main();
