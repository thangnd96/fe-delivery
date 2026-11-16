// State locations. Two zones live outside the repository:
//   agent zone (~/.fe-delivery/agent): written by the fe CLI that the model runs (sandbox allowWrite).
//   hook zone  (~/.fe-delivery/hook):  written only by hooks; never add it to sandbox allowWrite.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function feHome() {
  return resolve(process.env.FE_DELIVERY_HOME || join(homedir(), '.fe-delivery'));
}

export function pluginRoot() {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv) return resolve(fromEnv);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function feCliPath() {
  return join(pluginRoot(), 'scripts', 'fe.mjs');
}

export function repoKey(commonDir) {
  const parent = basename(dirname(resolve(commonDir))) || 'repo';
  const safe = parent.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(resolve(commonDir)).digest('hex').slice(0, 12);
  return `${safe}-${hash}`;
}

export const zones = {
  agent: (key) => join(feHome(), 'agent', key),
  hook: (key) => join(feHome(), 'hook', key),
  sessions: () => join(feHome(), 'hook', '_sessions'),
  cache: () => join(feHome(), 'hook', '_cache'),
};

export function agentRunDir(key, runId) {
  return join(zones.agent(key), 'runs', runId);
}

export function hookRunDir(key, runId) {
  return join(zones.hook(key), 'runs', runId);
}

// Paths that are Spec Kit / tool artifacts, not product source. Gates and diff budgets ignore them.
export const ARTIFACT_PREFIXES = ['specs/', '.specify/', '.claude/', 'pilothify-out/', '.fe-delivery/'];

export function isArtifactPath(rel) {
  return ARTIFACT_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
}
