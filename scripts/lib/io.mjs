// Hook stdin/stdout helpers. Hooks never print "allow": silence defers to the normal
// permission flow, so a hook can only make things stricter.
import { readFileSync } from 'node:fs';

export function readHookInput() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function denyTool(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `fe-delivery: ${reason}`,
    },
  };
}

export function addContext(eventName, text) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
}

export function block(reason) {
  return { decision: 'block', reason: `fe-delivery: ${reason}` };
}
