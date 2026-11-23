import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentRunDir, hookRunDir, zones } from './paths.mjs';

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

export function mtimeMs(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- hook zone (hooks only) ----------
const activeFile = (key) => join(zones.hook(key), 'active.json');

export function getActiveRunId(key, worktree) {
  return readJson(activeFile(key), {})[worktree] || null;
}

export function setActiveRun(key, worktree, runId) {
  const map = readJson(activeFile(key), {});
  map[worktree] = runId;
  writeJson(activeFile(key), map);
}

export function clearActiveRun(key, worktree) {
  const map = readJson(activeFile(key), {});
  delete map[worktree];
  writeJson(activeFile(key), map);
}

export const hookFiles = (key, runId) => {
  const dir = hookRunDir(key, runId);
  return {
    dir,
    state: join(dir, 'state.json'),
    approvals: join(dir, 'approvals.json'),
    evidence: join(dir, 'evidence.json'),
    diff: join(dir, 'diff.json'),
    events: join(dir, 'events.jsonl'),
  };
};

export function appendEvent(key, runId, event) {
  const f = hookFiles(key, runId).events;
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function readEvents(key, runId) {
  try {
    return readFileSync(hookFiles(key, runId).events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function sessionMarkerFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return join(zones.sessions(), `${safe}.json`);
}

// ---------- agent zone (fe CLI) ----------
export const agentFiles = (key, runId) => {
  const dir = agentRunDir(key, runId);
  return {
    dir,
    run: join(dir, 'run.json'),
    intake: join(dir, 'intake.json'),
    classification: join(dir, 'classification.json'),
    claims: join(dir, 'claims.json'),
    report: join(dir, 'report.md'),
    graph: join(dir, 'graph-log.json'),
  };
};

export function exists(file) {
  return existsSync(file);
}
