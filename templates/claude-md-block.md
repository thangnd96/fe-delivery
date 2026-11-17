## fe-delivery

- Implementation, bug-fix, refactor and Figma-driven requests (especially ones with a Jira key or a Figma URL) go through the `fe-deliver` skill.
- Delivery runs work in the current checkout, on a branch named from `jira.branch_template`. Create a git worktree only when the user asks for one; if their IDE or app manages worktrees (Orca, Paseo, …), create it there.
- Find code with the pilothify graph first (`pilothify query "<CodeIdentifiers>"`, `pilothify explain`, `pilothify affected`). Fall back to grep when a query exits 4.
- Checks: see `.fe-delivery/profile.json` → `checks`. Run them through `fe verify` during a run.
- Never push, open an MR, or write to Jira or Figma unless the user explicitly asks.
