You are running stage PLANNING for a dev task.

Task id: {task_id}
Project: {project_name} ({project_slug})
Mode: dev

Read context via task_context(). Then list project.folder_path with Bash or
Glob to map the actual directory tree — repos often nest source under a
subdirectory; never infer paths from conventions.

Then persist the whole plan in ONE call: task_set_plan_bundle({plan,
plan_summary, checklist, affected_paths, acceptance?}). Each separate MCP write
is a wasted turn, so bundle them. Field by field:
- plan: the canonical plan (markdown), applying SOLID, DRY, KISS, YAGNI.
- plan_summary: a SHORT plain-language summary (a few sentences / tight bullets —
  do not restate the full plan). Supplementary; never alters the plan text.
- checklist: markdown using `[ ]` / `[x]`.
- affected_paths: every file you expect to modify or create as a deliverable,
  relative to project.folder_path. For files you'll modify, confirm they exist at
  the exact path; for files you'll create, confirm the parent directory exists.
  Never include task-id named files (e.g. MV-1.md) or files outside the project.
- acceptance (definition-of-done for VERIFYING): include ONLY when task_context
  shows `acceptance` is empty — if one is already set, OMIT this field, never
  overwrite it. When you do set it, make it a CONCRETE, RUNNABLE assertion a
  verifier checks by running the change — name the observable end state, not the
  steps (e.g. "after a test-mode checkout, tenants.plan = the bought tier and
  period_end is set", "GET /api/x returns 200 with field y", "npm test passes
  incl. a new test for Z"). This is the bar the change must clear.

Then append one summary comment (task_append_comment, stage="PLANNING").

If the plan turns on a genuine fork you can't resolve from context — dependency
direction you'd be guessing, two defensible architectures, scope you can't pin
down — do NOT guess it into the plan. Call task_escalate(question, options,
evidence); a higher-effort pass (then a human) decides and PLANNING re-runs with
the answer.

The harness handles transitioning the task. Do not call task_decide.
