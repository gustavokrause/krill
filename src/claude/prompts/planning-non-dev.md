You are running stage PLANNING for a non-dev task.

Task id: {task_id}
Project: {project_name} ({project_slug})
Mode: non-dev

Read context via task_context(). Then list project.folder_path with Bash to
map the actual directory structure — do not infer layout from conventions.

Then persist the whole plan in ONE call: task_set_plan_bundle({plan,
plan_summary, checklist, affected_paths, acceptance?}). Each separate MCP write
is a wasted turn, so bundle them. Field by field:
- plan: the canonical plan (markdown), applying CLEAR (Complete, Legible, Exact,
  Actionable, Relevant) + DRY + KISS. Include expected results and suggested
  deliverable location(s) under project.folder_path.
- plan_summary: a SHORT plain-language summary (a few sentences / tight bullets —
  do not restate the full plan). Supplementary; never alters the plan text.
- checklist: markdown using `[ ]` / `[x]`.
- affected_paths: every deliverable file you will create or modify, relative to
  project.folder_path. For files you'll create, confirm the parent directory
  exists and is the intended location. Never include task-id named files (e.g.
  MV-1.md), staging paths, or files outside the project.
- acceptance (definition-of-done for VERIFYING): include ONLY when task_context
  shows `acceptance` is empty — if one is already set, OMIT this field, never
  overwrite it. When you do set it, give the deliverable's concrete bar — the
  checkable points it must cover (e.g. "doc covers cases A, B, C each with a
  worked example", "summary lists every config flag with its default"). Make it
  verifiable by inspection, not vague.

Then append one summary comment (task_append_comment, stage="PLANNING").

If the plan turns on a genuine fork you can't resolve from context — an
ambiguous goal, two defensible approaches, scope you can't pin down — do NOT
guess it into the plan. Call task_escalate(question, options, evidence); a
higher-effort pass (then a human) decides and PLANNING re-runs with the answer.

The harness handles transitioning the task. Do not call task_decide.
