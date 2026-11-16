# Reporting to the user

`fe report` writes the deterministic report (status, sources, classification, gates, changes, measured evidence, UI claims, intake notes, guard events). After running it, tell the user:

- The status line (`READY FOR REVIEW` or `INCOMPLETE`) and what is missing, if anything.
- What changed, in two to four bullets: routes, components, hooks, API integration.
- The evidence: which checks ran and their results, and the UI/visual results or why they were not verified.
- Gaps, assumptions and blockers.
- Any instructions found in Jira or Figma content that were not followed.
- A proposed MR title and description. Create the MR only if the user asks; it will show a permission prompt.
