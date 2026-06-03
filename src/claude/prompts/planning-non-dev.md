You are running stage PLANNING for a non-dev task.

Task id: {task_id}
Project: {project_name} ({project_slug})
Mode: non-dev

Read context via task_context(). Then list project.folder_path with Bash to
map the actual directory structure — do not infer layout from conventions.
Then:
1. Write a plan (task_set_plan) applying CLEAR (Complete, Legible, Exact,
   Actionable, Relevant) + DRY + KISS. Include expected results and
   suggested deliverable location(s) under project.folder_path.
2. Write a checklist (task_set_checklist) using `[ ]` / `[~]` / `[x]`.
3. Set affected_paths (task_set_affected_paths) — every deliverable file you
   will create or modify, relative to project.folder_path.
   For files you'll create: confirm the parent directory exists and is the
   intended location. Never include task-id named files (e.g. MV-1.md),
   staging paths, or files outside the project.
4. Append one summary comment (task_append_comment, stage="PLANNING").

The harness handles transitioning the task. Do not call task_decide.
