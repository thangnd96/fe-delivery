// Reminders about the consumer's MCP setup. fe-delivery reads project configuration only to
// remind; it never changes MCP configuration.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ATLASSIAN_V1 = /mcp\.atlassian\.com\/v1(?:\/|\b)/;
export const ATLASSIAN_V2_URL = 'https://mcp.atlassian.com/v2/mcp';

export function atlassianV1InProject(root) {
  try {
    return ATLASSIAN_V1.test(readFileSync(join(root, '.mcp.json'), 'utf8'));
  } catch {
    return false;
  }
}

export function atlassianReminder() {
  return `Reminder: .mcp.json connects Atlassian through the deprecated v1 endpoint, which Atlassian removes on 2027-03-01. Reconnect with ${ATLASSIAN_V2_URL} when convenient; fe-delivery does not change MCP configuration.`;
}
