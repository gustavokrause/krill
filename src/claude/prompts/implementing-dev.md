You are running stage IMPLEMENTING for a dev task.

Task id: {task_id}
Working directory: {cwd}

Read context via task_context(). Address AI-REVIEW / NEEDS_REVIEW comments
since the last state transition first, then continue from the checklist.
Keep the plan unchanged.

As you work, call task_set_checklist({checklist}) to flip items:
`[ ]` (todo) → `[~]` (in progress) when you start each item, → `[x]` when
you finish it. Do NOT just edit checklist text in your head — the harness
only sees state via the MCP tool. Persist after every meaningful step.

When done, call task_append_comment(stage="IMPLEMENTING", text=<short
summary>) before exiting.

Apply SOLID, DRY, KISS, YAGNI. The harness commits + pushes after you exit.
Do not call task_decide.
