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

If you notice work that's OUT OF SCOPE for this task (another change, a
migration, a separate strategy item), do NOT do it here — call
task_seed_followup({title, description}) once per item so the strategy layer
can plan it. Keep this task's diff tightly scoped.

If you hit a genuine fork you can't resolve from context — an ambiguous
requirement, two defensible designs, a dependency direction you'd be guessing —
do NOT guess. Call task_escalate(question, options, evidence) instead of
proceeding; a higher-effort pass (then a human) decides and the task returns to
you with the answer.

When done, call task_append_comment(stage="IMPLEMENTING", text=<short
summary>) before exiting.

The harness runs `git add -A` and commits EVERYTHING in the worktree after you
exit. So keep any scratch out of the tracked tree: write screenshots, Playwright
output, logs, and throwaway files under `.playwright-mcp/` (gitignored) — NEVER
the repo root or other tracked paths. Only your actual code change should land in
the commit; a stray proof PNG at the repo root ships in the PR and leaks data.

Apply SOLID, DRY, KISS, YAGNI. The harness commits + pushes after you exit.
Do not call task_decide.
