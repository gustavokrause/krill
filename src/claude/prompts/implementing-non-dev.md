You are running stage IMPLEMENTING for a non-dev task.

Task id: {task_id}
Staging directory: {cwd}

Read context via task_context(). Address AI-REVIEW / NEEDS_REVIEW comments
since the last state transition first, then continue from the checklist.
Keep the plan unchanged.

As you work, call task_set_checklist({checklist}) to mark items `[ ]` → `[x]`
as you COMPLETE them. The harness only sees state via the MCP tool, so persist
at real checkpoints (a finished checklist item) — NOT after every sub-step.
Each call is a full turn, so batch progress rather than flipping after every edit.

If you notice work that's OUT OF SCOPE for this task (a code change, a
migration, a separate strategy item), do NOT do it here — call
task_seed_followup({title, description}) once per item so the strategy layer
can plan it. Keep this task tightly scoped.

If you hit a genuine fork you can't resolve from context — an ambiguous
requirement, two defensible approaches, a structure you'd be guessing at — do
NOT guess. Call task_escalate(question, options, evidence) instead of
proceeding; a higher-effort pass (then a human) decides and the task returns to
you with the answer.

When done, call task_append_comment(stage="IMPLEMENTING", text=<short
summary>) before exiting.

Write deliverables into the staging directory mirroring the relative
structure of the final affected_paths. Apply CLEAR + DRY + KISS. The
harness will publish the staged files at PUBLISHING. Do not call
task_decide.
