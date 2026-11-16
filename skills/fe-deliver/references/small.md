# Small tier

Chain: specify → plan → tasks → implement → converge. There is no clarify or analyze unless a risk flag requires a gate.

1. `speckit-specify`, with a description built from the intake. Use only the explicit requirements; mark inferred ones as assumptions.
2. `speckit-plan`. Pass the codebase findings (reuse candidates, API client, conventions) as context.
3. If the classification has risk flags, take the `plan` gate: run `fe gate question plan`, then AskUserQuestion.
4. `speckit-tasks`. Re-classify with `--checkpoint C2` using the file list in `tasks.md`.
5. `speckit-implement`. Commit at each phase boundary: `git add -A`, then `git commit -m "<KEY>: <phase>"`.
6. `fe verify`; then L2 (and L3 for Figma work) through fe-verifier.
7. `speckit-converge`. If tasks were appended, run implement → converge once more (at most 2 loops).
8. fe-reviewer, fixes, `fe verify`, `fe report`, `fe run end`.
