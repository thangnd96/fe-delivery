# Classification input for `fe classify -`

```json
{
  "task_type": "feature",
  "model_tier": "small",
  "size": {
    "scope":       { "score": 1, "evidence": "one page: ProfilePage" },
    "logic_state": { "score": 1, "evidence": "form + validation" },
    "data_api":    { "score": 0, "evidence": "existing fetchProfile client" },
    "design":      { "score": 1, "evidence": "reuses Button, new Avatar variant" }
  },
  "predicted_files": ["src/features/profile/ProfileCard.tsx", "src/features/profile/ProfileCard.test.tsx"],
  "blocking_questions": [],
  "risk_flags": [{ "category": "backend_contract", "source": "jira_link", "detail": "blocked by BE-77" }],
  "reason": "C1 after intake"
}
```

- `task_type` is one of `feature`, `bug`, `refactor`, `chore`, `documentation`. A bug always gets tier `bug`.
- **Size axes, each scored 0–2 with evidence:**
  - **scope:** 0 = one component · 1 = one page or module · 2 = several modules.
  - **logic_state:** 0 = presentational · 1 = forms, filters, local state · 2 = multi-step flows, cache or store shape.
  - **data_api:** 0 = no new data · 1 = existing endpoint · 2 = new or unready API.
  - **design:** 0 = existing components with all states drawn · 1 = new variants · 2 = new components or missing states.
- **`model_tier`** is your judgment (`trivial` | `small` | `medium` | `large`). The CLI raises it to the floor computed from the number of predicted files.
- **`predicted_files`** come from intake and graph queries. The CLI flags risk areas from the profile globs and measures the blast radius on the pilothify graph (EXTRACTED edges only).
- **Uncertainty is not a score.** Put unanswered questions that block implementation in `blocking_questions`. Edits stay blocked until the list is empty.
- **Override:** add `"override": {"requested_tier": "small", "reason": "..."}`. Going below the floor adds the `override` gate.
- **Re-classify** with `--checkpoint C2` after `tasks.md` exists (use its file list), and with `--checkpoint C3` when a hook reports a risk area or diff budget.
