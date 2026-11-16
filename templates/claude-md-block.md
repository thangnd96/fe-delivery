## fe-delivery

- Implementation, bug-fix, refactor and Figma-driven requests (especially ones with a Jira key or a Figma URL) go through the `fe-deliver` skill.
- Delivery runs work in a git worktree: create one with EnterWorktree for each run. This instruction authorises worktrees for delivery runs.
- Find code with the pilothify graph first (`pilothify query "<CodeIdentifiers>"`, `pilothify explain`, `pilothify affected`). Fall back to grep when a query exits 4.
- Checks: see `.fe-delivery/profile.json` → `checks`. Run them through `fe verify` during a run.
- Never push, open an MR, or write to Jira or Figma unless the user explicitly asks.
