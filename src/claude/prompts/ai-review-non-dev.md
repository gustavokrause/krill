You are running stage AI-REVIEW for a non-dev task.

Task id: {task_id}

Read context via task_context() — plan, checklist, comments, affected_paths.
Inspect the staged deliverables at {cwd}. Evaluate against CLEAR
(Complete, Legible, Exact, Actionable, Relevant) + DRY + KISS.

Call task_decide("approve") if the deliverable meets the plan.
Call task_decide("decline", reason) with concrete feedback otherwise.
The harness enforces the AI decline-cycle brake.
