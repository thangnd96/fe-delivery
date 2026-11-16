// Resolves everything a hook or CLI command needs about the current repository.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { commonDir, toplevel } from './git.mjs';
import { repoKey } from './paths.mjs';
import { validateNamed } from './schema.mjs';
import { getActiveRunId } from './state.mjs';

export const PROFILE_PATH = '.fe-delivery/profile.json';

export function loadProfile(root) {
  const file = join(root, PROFILE_PATH);
  if (!existsSync(file)) return { profile: null, errors: [] };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { profile: null, errors: [`${PROFILE_PATH}: invalid JSON (${e.message})`] };
  }
  const errors = validateNamed('profile', data).map((m) => `${PROFILE_PATH}${m}`);
  return { profile: errors.length ? null : data, errors };
}

// Returns null when cwd is not inside a git repository that has an fe-delivery profile.
// A worktree with an active run keeps its context even if the profile file disappears:
// the run's frozen profile (applyRunProfile in run.mjs) still applies.
export function repoContext(cwd) {
  const root = toplevel(cwd || process.cwd());
  if (!root) return null;
  const { profile, errors } = loadProfile(root);
  const common = commonDir(root) || join(root, '.git');
  const key = repoKey(common);
  const activeRunId = getActiveRunId(key, root);
  if (!profile && errors.length === 0 && !activeRunId) return null;
  return { root, key, profile, profileErrors: errors, activeRunId };
}

export function relToRoot(root, filePath) {
  if (!filePath) return null;
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

export function normalizeAgentType(agentType) {
  if (!agentType) return null;
  const parts = String(agentType).split(':');
  return parts[parts.length - 1];
}
