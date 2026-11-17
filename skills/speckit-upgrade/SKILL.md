---
name: speckit-upgrade
description: Upgrade Spec Kit in the current repository to the version fe-delivery has validated, on its own branch, with review. Run only when the user invokes /fe-delivery:speckit-upgrade.
disable-model-invocation: true
---

# speckit-upgrade (U3)

1. **Read the versions.** Get the target from the plugin's `compat/speckit.json` (`speckit.tested`), the current pin from `.fe-delivery/profile.json` (`versions.speckit`), and the installed CLI from `specify version`. Show the three to the user.
2. **Branch.** In the current checkout, run `git switch -c chore/speckit-v<target>`. If the working tree has uncommitted changes, ask the user first. Use a worktree only when the user asks for one: through their IDE or app when it manages worktrees (Orca, Paseo, …), otherwise with EnterWorktree.
3. **CLI.** Run `specify self upgrade --dry-run`, show the plan, and after approval run `specify self upgrade --tag v<target>`.
4. **Project files.**
   - Run `specify integration status`.
   - Run `specify integration upgrade claude` **without `--force`**. If it blocks on locally modified managed files, stop and show the files. Never pass `--force`.
5. **Extensions.** Run `specify extension update`.
6. **Pin.** Set `versions.speckit` in `.fe-delivery/profile.json` to the target, then run `fe profile check`.
7. **Check.**
   - Run the repo checks: `fe verify`, or the profile commands when no run is active.
   - Confirm the skills listed in `compat/speckit.json` exist under `.claude/skills/`.
8. **Commit.** Commit on the branch, then summarise the release notes between the two versions. Push and MR creation need the user's approval through permission prompts. Never merge automatically.
