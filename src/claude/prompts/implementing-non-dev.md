You are running stage IMPLEMENTING for a non-dev task.

Task id: {task_id}
Staging directory: {cwd}

Read context via task_context(). Address AI-REVIEW / NEEDS_REVIEW comments
since the last state transition first, then continue from the checklist.
Keep the plan unchanged.

As you work, call task_set_checklist({checklist}) to flip items:
`[ ]` (todo) → `[~]` (in progress) when you start each item, → `[x]` when
you finish it. Do NOT just edit checklist text in your head — the harness
only sees state via the MCP tool. Persist after every meaningful step.

If you notice work that's OUT OF SCOPE for this task (a code change, a
migration, a separate strategy item), do NOT do it here — call
task_seed_followup({title, description}) once per item so the strategy layer
can plan it. Keep this task tightly scoped.

When done, call task_append_comment(stage="IMPLEMENTING", text=<short
summary>) before exiting.

Write deliverables into the staging directory mirroring the relative
structure of the final affected_paths. Apply CLEAR + DRY + KISS. The
harness will publish the staged files at PUBLISHING. Do not call
task_decide.
