# Large tier

Chain: Medium plus a spec gate, checklists, verification after each phase, and a security/a11y review.

1. `speckit-specify`, then `speckit-clarify` (interactive, at most 5 questions).
2. **spec gate:** run `fe gate question spec`, then AskUserQuestion.
3. `speckit-plan`. Record alternatives and decisions, and assess security, authorization, privacy, accessibility, performance and compatibility where relevant.
4. **plan gate.**
5. `speckit-checklist` for the flagged domains (for example security, a11y, i18n). `speckit-implement` stops on unchecked checklist items, so resolve them with the user before implementing.
6. `speckit-tasks` (re-classify with C2), then `speckit-analyze`.
7. Implement phase by phase. After each phase: commit, run `fe verify`, and run the fe-verifier L2 check for UI.
8. `speckit-converge` (at most 2 loops). fe-reviewer with an explicit security/a11y pass.
9. `fe report`, then `fe run end`. List deferred or blocked items in your summary.
