# Trivial tier (no Spec Kit)

For changes of at most a few files (see the profile budget) with no behavior ambiguity, such as copy changes, a style fix or a small prop.

1. List the acceptance criteria in two to five bullets in your reply to the user.
2. If the classification has risk flags, take the `plan` gate first: run `fe gate question plan`, then AskUserQuestion.
3. Make the change. Reuse existing components and tokens; check with `pilothify explain` before adding anything.
4. Commit locally: `git add -A`, then `git commit -m "<KEY>: <summary>"`.
5. Run `fe verify`. For UI changes, run the L2 check (fe-verifier), or record `not_verified` with a reason.
6. Run `fe report`, then `fe run end`.

If the diff budget is exceeded, re-classify (C3) and switch to the Small tier.
