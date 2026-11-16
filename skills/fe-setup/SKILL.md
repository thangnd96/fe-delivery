---
name: fe-setup
description: Set up fe-delivery in the current front-end repository (profile, settings, Spec Kit, pilothify graph, CLAUDE.md block). Run only when the user invokes /fe-delivery:fe-setup.
disable-model-invocation: true
---

# fe-setup

Prepare this repository for fe-delivery. Inspect first, then show a plan and wait for the user's approval before editing. Never overwrite existing files; merge into them. Every install command needs the user's approval.

## 1. Inspect and report
- Repo root, branch and `git status`; the package manager and package scripts; monorepo layout.
- Existing `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json` and `.specify/`.
- Test tooling: vitest/jest, MSW, Storybook, Playwright.
- MCP servers: there must be exactly **one** Atlassian server, on the v2 endpoint.
- Run `node "<plugin>/scripts/fe.mjs" doctor`.

## 2. Prerequisites (each needs approval)
- **Spec Kit,** pinned to `compat/speckit.json` → `speckit.tested`: `uv tool install specify-cli==<tested>`.
  - An existing Spec Kit project: `specify integration install claude`.
  - Otherwise use the documented init. Explain what it touches; no `--force` unless the user approves.
- **Bug extension:** `specify extension add bug`.
- **Do not install the Spec Kit `git` extension.** Its mandatory `before_specify` hook creates `{number}-{slug}` branches, while fe-delivery owns worktrees and branch names. If it is already installed, tell the user and propose `specify extension remove git`.
- **pilothify,** from GitHub only, pinned: `uv tool install "pilothify[leiden,mcp,sql] @ git+https://github.com/thangnd96/pilothify@v0.1.5"`. Never `pip install pilothify`, and never `pilothify install`.

## 3. Files (merge, never overwrite)
- **`.fe-delivery/profile.json`** from `templates/profile.example.json`:
  - checks from the real package scripts (use `null` when a script does not exist);
  - risk globs adapted to the real tree, plus the hubs from `pilothify god-nodes --json --top 30`;
  - Jira project keys and site from the user.

  Validate with `fe profile check`.
- **`.claude/settings.json`:** merge `templates/settings.example.json` and keep the existing keys, including any `hooks` that Spec Kit registered for extension events.
  - Adjust the MCP tool prefixes to the servers actually configured (`/mcp`).
  - Keep `sandbox.filesystem.allowWrite` limited to `~/.fe-delivery/agent`; never the hook zone.
- **`CLAUDE.md`:** append `templates/claude-md-block.md`. It authorises worktrees for delivery runs.
- **pilothify config:** `.pilothifyignore` and `.pilothifyrc` from the templates.
- **`.gitignore`:** add `pilothify-out/`.
- **`.specify/memory/constitution.md`:** derive it from the real conventions, and ask before resolving conflicting rules.

## 4. Graph and baseline
- Build the graph: `fe graph ensure`. Report the node count and build time.
- Tell the user to record the token baseline from a pilothify checkout before using fe-delivery: `python -m tools.adherence <this repo>`.

## 5. Contributors
Tell the user that every contributor runs, after trusting the folder:
`claude plugin install fe-delivery@piloth-marketplace --scope project`
`enabledPlugins` alone does not install the plugin.

## 6. Shadow run
Offer a shadow run on 3 tickets the user names: `/fe-delivery:fe-deliver [stop-after:plan] <KEY>`. It makes no source edits; report the classifications.
