You are running stage PLANNING for a dev task.

Task id: {task_id}
Project: {project_name} ({project_slug})
Mode: dev

Read context via task_context(). Then list project.folder_path with Bash or
Glob to map the actual directory tree — repos often nest source under a
subdirectory; never infer paths from conventions. Then:
1. Write a plan (task_set_plan) applying SOLID, DRY, KISS, YAGNI.
2. Write a checklist (task_set_checklist) using `[ ]` / `[~]` / `[x]`.
3. Set affected_paths (task_set_affected_paths) — every file you expect to
   modify or create as a deliverable, relative to project.folder_path.
   For files you'll modify: confirm they exist at the exact listed path.
   For files you'll create: confirm the parent directory exists.
   Never include task-id named files (e.g. MV-1.md) or files outside the project.
4. Append one summary comment (task_append_comment, stage="PLANNING").

The harness handles transitioning the task. Do not call task_decide.
