// U1 — UserPromptSubmit: detect Jira keys (configured projects only), Figma URLs and
// override tokens; record a per-session pending marker; add context. Never blocks.
import { rmSync } from 'node:fs';
import { addContext } from '../lib/io.mjs';
import { feCliPath } from '../lib/paths.mjs';
import { readJson, sessionMarkerFile, writeJson } from '../lib/state.mjs';

const FIGMA_RE = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board|make|proto)\/[A-Za-z0-9]+[^\s)\]>"']*/g;
const TOKEN_RE = /\[(tier|lane|stop-after):([a-z-]+)\]/g;

export function parsePrompt(prompt, projectKeys) {
  const text = String(prompt || '');
  const keys = new Set();
  if (projectKeys?.length) {
    const alt = projectKeys.map((k) => k.replace(/[^A-Z0-9_]/gi, '')).filter(Boolean).join('|');
    if (alt) {
      const re = new RegExp(`\\b(?:${alt})-\\d+\\b`, 'g');
      for (const m of text.matchAll(re)) keys.add(m[0]);
    }
  }
  const figma = [...new Set(text.match(FIGMA_RE) || [])];
  const overrides = {};
  for (const m of text.matchAll(TOKEN_RE)) overrides[m[1]] = m[2];
  const noRun = /\[no-run\]/.test(text);
  return { jira_keys: [...keys], figma_urls: figma, overrides, no_run: noRun };
}

export function onUserPromptSubmit(input, ctx) {
  if (!ctx?.profile) return null;
  const parsed = parsePrompt(input.prompt, ctx.profile.jira?.project_keys);
  const markerFile = sessionMarkerFile(input.session_id);
  if (parsed.no_run) {
    rmSync(markerFile, { force: true });
    return addContext('UserPromptSubmit', 'fe-delivery: [no-run] given; delivery workflow not required for this request.');
  }
  if (parsed.jira_keys.length === 0 && parsed.figma_urls.length === 0) return null;
  const previous = readJson(markerFile, { jira_keys: [], figma_urls: [] });
  writeJson(markerFile, {
    session_id: input.session_id || null,
    jira_keys: [...new Set([...previous.jira_keys, ...parsed.jira_keys])],
    figma_urls: [...new Set([...previous.figma_urls, ...parsed.figma_urls])],
    at: new Date().toISOString(),
  });
  const lines = [
    'fe-delivery: this request references delivery sources, so it must go through the fe-deliver skill.',
    parsed.jira_keys.length ? `Jira: ${parsed.jira_keys.join(', ')}` : null,
    parsed.figma_urls.length ? `Figma: ${parsed.figma_urls.join(' ')}` : null,
    Object.keys(parsed.overrides).length ? `Overrides: ${JSON.stringify(parsed.overrides)}` : null,
    `Edits and Spec Kit skills stay blocked until a run is started: node "${feCliPath()}" run start --jira <KEY> ...`,
    'If the user did not ask for implementation, answer normally; the user can add [no-run] to opt out.',
  ].filter(Boolean);
  return addContext('UserPromptSubmit', lines.join('\n'));
}
