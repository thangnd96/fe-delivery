---
name: fe-uninstall
description: Remove fe-delivery from the current repository cleanly, using the install manifest, without touching product source. Run only when the user invokes /fe-delivery:fe-uninstall.
disable-model-invocation: true
---

# fe-uninstall

Remove fe-delivery's footprint from this repository. Product source, `specs/`, the Spec Kit constitution, worktrees, branches and history are never touched.

## 1. Preview (read-only)
Run `node "<plugin>/scripts/fe.mjs" uninstall --dry-run`, then show the user:
- every path that will change, and how:
  - `restore`: byte for byte, because the file was not edited after install;
  - `remove-entries` / `remove-block`: only fe-delivery's parts are removed, your edits stay;
  - `delete`: the file was created by install;
  - `keep`: the file was edited, so it is left in place;
- the list of things that are never touched;
- blockers:
  - **active runs:** finish them with `fe run end` first, or pass `--force-runs`. Worktrees are never deleted;
  - **uncommitted changes in recorded files:** commit or stash them first.
- the optional `--speckit` step, offered only when fe-setup installed Spec Kit here. It runs `specify extension remove bug` and `specify integration uninstall claude`; Spec Kit keeps files you edited. Ask whether the team still wants Spec Kit.

If there is no install manifest, the repository was set up without `fe install`. Do not guess. Show the manual list from the uninstall guide and remove only what the user confirms.

## 2. Apply (run by the user)
The command edits `.claude/settings.json`, which is a protected path, and may clear machine state outside the sandbox. Ask the user to run it with the `!` prefix, or in a terminal:

```
node "<plugin>/scripts/fe.mjs" uninstall [--speckit] [--machine-state]
```

- `--machine-state` also deletes this repository's ledger under `~/.fe-delivery/`. Without it, past run reports stay available.
- The command ends with a safety check. If anything outside the manifest changed, it fails with exit code 2 and lists the paths.

## 3. Verify and finish
1. Run `git status` and `git diff --stat`. Only the recorded paths may appear.
2. The user reviews the diff and commits.
3. Remove the plugin:
   - `claude plugin uninstall fe-delivery@piloth-marketplace --scope project`, and `--scope user` if it was installed there too.
   - Keep the `piloth-marketplace` registration if the piloth plugin is in use. Otherwise remove it with `claude plugin marketplace remove piloth-marketplace`.
4. Optional, per machine and only if no other project needs them: `uv tool uninstall specify-cli` and `uv tool uninstall pilothify`.
