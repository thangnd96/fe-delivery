---
name: fe-setup
description: Set up fe-delivery in the current front-end repository (profile, settings, Spec Kit, pilothify graph, CLAUDE.md block). Run only when the user invokes /fe-delivery:fe-setup.
disable-model-invocation: true
---

# fe-setup

Prepare this repository for fe-delivery. Inspect first, then show a plan and wait for the user's approval before changing anything. Every install command needs the user's approval.

**All repository files are written by `fe install`, never by hand.** `fe install` records each change in `.fe-delivery/install-manifest.json`, so that `/fe-delivery:fe-uninstall` can revert exactly that footprint.

## 1. Inspect and report
- Repo root, branch and `git status` (the working tree should be clean); the package manager and package scripts; monorepo layout.
- Existing `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json` and `.specify/`.
- Test tooling: vitest/jest, MSW, Storybook, Playwright.
- MCP servers: note which Atlassian and Figma servers are connected; their tool prefixes decide which permission rules apply. If an Atlassian server uses the deprecated v1 endpoint, remind the user that it can be reconnected on `https://mcp.atlassian.com/v2/mcp`. Do not change the user's MCP configuration.
- Run `node "<plugin>/scripts/fe.mjs" doctor`.

## 2. Prerequisites (each needs approval)
- **Spec Kit,** pinned to `compat/speckit.json` → `speckit.tested`: `uv tool install specify-cli==<tested>`.
  - An existing Spec Kit project: `specify integration install claude`.
  - Otherwise use the documented init. Explain what it touches; no `--force` unless the user approves.
  - Note whether **this setup** installed Spec Kit into the repository. You pass that to `fe install` below.
- **Bug extension:** `specify extension add bug`.
- **Do not install the Spec Kit `git` extension.** Its mandatory `before_specify` hook creates `{number}-{slug}` branches, while fe-delivery owns worktrees and branch names. If it is already installed, tell the user and propose `specify extension remove git`.
- **pilothify,** from GitHub only, pinned: `uv tool install "pilothify[leiden,mcp,sql] @ git+https://github.com/thangnd96/pilothify@v0.1.5"`. Never `pip install pilothify`, never `pilothify install`, and do not install pilothify git hooks: `fe graph ensure` keeps the graph fresh.

## 3. Profile
Draft `.fe-delivery/profile.json` from `templates/profile.example.json` and show it to the user:
- checks from the real package scripts (use `null` when a script does not exist). Offer to run each one on the clean checkout and report which are red. Explain that a run reaches READY FOR REVIEW only when every configured check passes; the user decides whether to fix a red check, use a narrower command, or set it to `null`;
- risk globs adapted to the real tree, plus the files of the hubs from `pilothify god-nodes --json --top 30` (graph nodes carry `source_file`);
- Jira project keys from the user, used only to recognise ticket keys in prompts (no Jira site is needed; leave the list empty when the team does not use Jira);
- `rollout.mode`: ask the user. `full` (the default) enables implementation; `shadow` makes every run stop after planning, which suits a trial without code changes.

## 4. Install (writes files and the manifest)
Run, with the approved profile on stdin:

```
node "<plugin>/scripts/fe.mjs" install --profile - [--speckit-installed-by-setup]
```

`fe install` will:
- create the profile;
- merge `templates/settings.example.json` into `.claude/settings.json`. It adds only missing keys and rules, never overwrites your values, and reports conflicts;
- append marked blocks to `CLAUDE.md` and `.gitignore`;
- create `.pilothifyignore` and `.pilothifyrc` only when they do not exist yet.

If the Bash sandbox blocks the write, ask the user to run the same command with the `!` prefix, or in a terminal. `.claude/` is a protected path.

Report the conflicts `fe install` printed. For example, `sandbox.enabled` kept at `false` means hook-zone protection is weaker.

## 5. Constitution
Write `.specify/memory/constitution.md` from the real conventions, and ask before resolving conflicting rules. This file belongs to Spec Kit, not to fe-delivery, and uninstall leaves it in place.

## 6. Graph, baseline, commit
- Build the graph with `fe graph ensure`. Report the node count and build time.
- Tell the user to record the token baseline from a pilothify checkout: `python -m tools.adherence <this repo>`. It reads Claude Code transcripts of this path on the machine that runs it (kept about 30 days by default), so each developer who already uses Claude Code here runs it on their own machine.
- Ask the user to review `git status` and commit the profile, the manifest and the merged files together.

## 7. Contributors
Every contributor runs, after trusting the folder:
`claude plugin install fe-delivery@piloth-marketplace --scope project`
`enabledPlugins` alone does not install the plugin.

## 8. Shadow run
Offer a shadow run on 3 tickets the user names: `/fe-delivery:fe-deliver <KEY>` when `rollout.mode` is `shadow`, otherwise `/fe-delivery:fe-deliver [stop-after:plan] <KEY>`. Hooks deny product-source edits (`[G7]`); report the classifications.
