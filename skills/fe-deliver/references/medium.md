# Medium tier

Chain: Small plus clarify, analyze, phased implementation and a reviewer. The `plan` gate is always required.

1. `speckit-specify`.
2. `speckit-clarify`. It asks the user one question at a time, at most 5. Never answer its questions yourself.
3. `speckit-plan`, covering component boundaries, API, state, routing, and loading/empty/error/success/permission states.
4. **plan gate:** run `fe gate question plan --summary "<plan in one line>"`, then AskUserQuestion. On "Reject", revise the plan.
5. `speckit-tasks`, grouped by phase. Re-classify with `--checkpoint C2`.
6. `speckit-analyze`. Fix any inconsistencies between spec, plan and tasks.
7. `speckit-implement`, one phase at a time. Commit after each phase and run `fe verify` after each phase.
8. fe-verifier (L2/L3), `speckit-converge` (at most 2 loops), fe-reviewer, fixes.
9. `fe verify`, `fe report`, `fe run end`.
