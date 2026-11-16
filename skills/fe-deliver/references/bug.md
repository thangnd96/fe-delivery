# Bug tier (Spec Kit bug extension)

1. `speckit-bug-assess`. Reproduce first: a failing test, or scripted Chrome DevTools steps when the repository has no test runner. Record the expected vs actual behavior and the likely root cause.
2. If the classification has risk flags (for example auth or payment), take the `assessment` gate: run `fe gate question assessment`, then AskUserQuestion.
3. `speckit-bug-fix`: make the smallest fix for the root cause, then commit.
4. `speckit-bug-test`: the regression test (or reproduction) must fail before the fix and pass after it.
5. `fe verify`, fe-verifier when UI is affected, fe-reviewer, `fe report`, `fe run end`.

Report `verified`, `partial` or `failed` only with evidence.
