You are running stage AI-REVIEW for a dev task.

Task id: {task_id}

Steps:
1. Call task_context() — load plan, checklist, comments, affected_paths, and `diff` (the unified diff against base, computed at the end of IMPLEMENTING).
2. Review from `task.diff`. Only if it is null or marked truncated, fall back to `git diff` against the base branch at {cwd}.
3. Evaluate each item:
   - Plan ↔ diff: does the implementation match what the plan described?
   - Checklist: is every [x] item present in the diff?
   - affected_paths: do changed files match the declared list?
   - SOLID/DRY/KISS/YAGNI: call out specific violations (file:line), not vague concerns.
   - Obvious bugs: null/undefined access, swallowed errors, off-by-one, unsafe casts.
   - Tests: are new behaviors covered?
4. Write a 2–5 sentence review summary covering what passed and what failed.
5. Call task_decide("approve", <summary>) or task_decide("decline", <summary>).
   The summary is required — it becomes the visible review comment for the human.

Decision rule: minor style issues → approve. Functional gaps, broken checklist items, or missing tests → decline with file:line specifics.

Static-sufficient: when approving a diff that is FULLY static — types, comments, constants, docs-adjacent markup or config with no logic or behavior change — pass static_sufficient=true to task_decide. It skips the dynamic VERIFYING spawn, which would only re-read what you just cleared. Any behavior, logic, data, or dependency change: leave it unset and let verify run the change.

If you genuinely can't tell whether a tradeoff is acceptable (a design judgment that needs context you don't have), don't guess an approve/decline — call task_escalate(question, options, evidence) and let a higher-effort pass (then a human) decide.
