
AI + HUMAN WORKFLOW


-- GLOBAL CONFIG --

  {worktrees_root} # path where per-task worktrees live; default "~/.ai-worktrees/"

  {automation_enabled} # bool — master kill switch; default true. When false, ALL crons exit no-op.
  {stage_enabled} # { todo_picker, planning, implementing, ai_review, publishing }: per-stage on/off; defaults all true. Allows pausing a single model lane (e.g., Opus rate-limited → set planning=false, ai_review=false; Sonnet stages continue).

  {publishing_solve_conflicts} # bool — sub-toggle for PUBLISHING stage; default false. When true, Sonnet attempts to resolve merge conflicts during the PUBLISHING tick. When false (default), conflicts skip LLM and force-move task to NEEDS_REVIEW(conflict) with PR open + comment so human resolves directly in GitHub OR clicks the per-task "Solve with Sonnet" CTA (the CTA is only shown when this toggle is false). PUBLISHING itself is LLM-free in the no-conflict path regardless of this setting.

  {cron_cadence} # per-stage cadence seconds; defaults: { todo_picker: 30, planning: 60, implementing: 60, ai_review: 60, publishing: 60 }. Stagger start times (:00, :15, :30, :45) so stages do not fire simultaneously.

  {max_stage_duration} # per-stage seconds; defaults: { planning: 900, implementing: 3600, ai_review: 900, publishing: 600 }. Used by stuck-task detection.

  {claim_ttl} # per-stage lock TTL seconds; defaults: { planning: 300, implementing: 1800, ai_review: 300, publishing: 300 }. Worker sets claimed_until=now()+TTL on claim.

  {api_error_backoff} # per-stage exponential backoff on API errors; sequence: 30s, 60s, 120s, cap 300s; reset on first success; isolated per-stage.

  {max_ai_decline_cycles} # int — caps AI-driven decline/conflict loops; default 3. After N consecutive AI auto-actions (without human input or forward state progress), AI force-moves task to NEEDS_REVIEW(conflict). Manual "Solve with Sonnet" CTA runs are excluded from the count (marked with the `[manual] ` comment prefix).

-- PROJECTS --

  Fields overview

    {name}
    {slug} # e.g.: "AT"
    {folder_path} # e.g.: /path/to/your/project — MANDATORY (deliverables land here, with or without git)
    {has_repo} # bool — auto-detected from .git at registration; can be edited; gates PR workflow
    {default_branch} # default "main"; branch tasks fork from (used only if has_repo)
    {max_parallel_tasks} # cap on active tasks per project; default 1; range 1-5
    {paused} # bool — pause this project without affecting others; default false

-- TASKS --

  Fields overview

    {name}
    {id} # project {slug} + "-" + N, where N is per-project monotonic counter starting at 1 (e.g., "AT-1", "AT-2", "AT-3")
    {project}
    {description}
    {priority} # enum: "P0" | "P1" | "P2" | "P3"; default "P2". P0=critical/blocker, P1=high, P2=medium/normal, P3=low/nice-to-have. Picker orders ASC ("P0" lexicographically smallest, picked first).

    {plan}
    {checklist}

    {created_at}
    {started_at}
    {updated_at}
    {ended_at}
    {stage_entered_at} # timestamp — set on every status transition; used for stuck-task detection

    {claimed_until} # timestamp | null — lock with TTL set on cron claim; cleared on stage completion. Stale claim auto-expires for next cron to pick up.
    {claimed_by} # string | null — worker id (debug/observability)

    {skip_plan} # bool — when true, the TODO picker routes the task TODO → IMPLEMENTING directly (no PLANNING tick, no plan/checklist, no plan review). Worktree/workspace setup runs lazily at the start of IMPLEMENTING. Use for trivial tasks where the human already supplied enough context. Implies skip_plan_review. Default false.
    {skip_plan_review} # bool — when true, NEEDS_REVIEW(plan) gate is bypassed; plan auto-approves and transitions straight to IMPLEMENTING. Has no effect when skip_plan is also true (no plan exists). Default false.
    {skip_ai_review} # bool — when true, AI-REVIEW gate is bypassed; after IMPLEMENTING, task jumps directly to PUBLISHING. Use for trivial tasks where AI review is overhead. Default false.

    {status} # enum: BACKLOG | TODO | PLANNING | IMPLEMENTING | AI-REVIEW | PUBLISHING | NEEDS_REVIEW | DONE | CANCELED
    {pending_review_kind} # enum: "plan" | "deliverable" | "conflict" | null — set iff status=NEEDS_REVIEW; discriminates which review gate the task is parked on. Cleared on every NEEDS_REVIEW exit.

    {depends_on} # [task_id, ...] hard deps only; cross-project allowed; default []
    {conflicts_with} # [task_id, ...] tasks that must not be active in parallel; AI proposes at PLANNING from {affected_paths} overlap, human override is sticky; default []
    {affected_paths} # [path/glob, ...] files/dirs the task reads, modifies, or creates; predicted at PLANNING end, overwritten at IMPLEMENTING end via `git diff --name-only {default_branch}...HEAD`; default []

    {branch} # auto-generated at PLANNING start when has_repo=true, e.g.: "at-1-create-user-model"; null otherwise
    {worktree_path} # auto-generated at PLANNING start when has_repo=true: {worktrees_root}/{project_slug}/{id}; null otherwise
    {workspace_path} # auto-generated at PLANNING start when has_repo=false: {folder_path}/.tasks/{id}/ (staging area for deliverables); null otherwise

    {comments} # append-only log. Each entry: { at, stage, author: "human"|"ai", text }. Stages append; readers filter by stage tag. Replaces former {plan_notes}, {implementation_notes}, {human_notes}.

    {mode} # enum: "dev" | "non-dev". "dev" = task modifies the app/codebase. "non-dev" = anything else (research, decisions, docs, copy, strategy, ops, etc.). Shapes prompt direction at PLANNING + IMPLEMENTING + AI-REVIEW. REJECT task creation if mode="dev" and project has_repo=false (impossible state).
    {delivery_url} # PR URL when has_repo=true with a remote; `local:<branch>` for the local-merge path (remote-less repo, A1); file/folder link when has_repo=false
    {auto_publish} # bool (A2) — when true AND project.allow_auto_finish=true, PUBLISHING skips the deliverable gate and merges straight to DONE. Double-gated; AI-REVIEW still runs. Default false. Set by the whale strategy layer.


  WORKFLOW:

    - BACKLOG
      - Human creates tasks adding {name}, selecting {project} (from Projects entity), {description}, {mode}, optional {priority} (defaults "P2")
        Validation:
          - REJECT if {mode}="dev" and project.{has_repo}=false (cannot make code changes in a project without a repo)
        Submit:
          - {created_at}
          - generates {id}
    - TODO
      - Human moves into "TODO";
      - Cron (deterministic SQL — no model)
        - scans tasks with status "TODO" ordered by {priority} ASC (P0 first), then {created_at} ASC (FIFO tie-breaker)
        - eligibility filter (skip if any fails):
          - all ids in {depends_on} must be status DONE
          - no active task (status in {PLANNING, IMPLEMENTING, AI-REVIEW, PUBLISHING}) with id in {conflicts_with}
          - project active count < {max_parallel_tasks}
        - cycles in {depends_on} are ignored (picker will keep skipping; human responsibility to resolve)
        - picks the top eligible task
          - atomic transition: UPDATE task SET status=(skip_plan ? 'IMPLEMENTING' : 'PLANNING') WHERE id=? AND status='TODO' (loser sees 0 rows, retries next). skip_plan tasks bypass the PLANNING tick entirely; worktree/workspace setup runs lazily on first IMPLEMENTING entry.
          - sets {started_at}
    - PLANNING (skipped entirely when {skip_plan}=true)
      - Opus cron
        - AI picks
          - on FIRST entry to PLANNING for this task:
            {IF project.has_repo}
              - create branch from origin/{default_branch} HEAD; set {branch}
              - create worktree at {worktrees_root}/{project_slug}/{id}; set {worktree_path}
            {ELSE}
              - mkdir {folder_path}/.tasks/{id}/; set {workspace_path}
            (Same setup runs lazily at the start of IMPLEMENTING when the picker routed a {skip_plan}=true task directly.)
          - load active peer tasks' {affected_paths} (same project + cross-project peers)
          - compute path overlap (glob-aware: `*`, `**`, relative to {folder_path})
          - for each overlapping peer, add peer id to {conflicts_with} (AI-set entries; do not overwrite human-set entries)
          - read {comments} tagged stage=NEEDS_REVIEW since last state transition (these carry plan-decline feedback); address feedback, otherwise write new plan:
              1. Update or write {plan} and {checklist} based on task {name} and {description}.
                {IF mode=="dev"}
                  - apply principles: SOLID, DRY, KISS, YAGNI
                {ELSE} # mode=="non-dev"
                  - apply principles: CLEAR (Complete, Legible, Exact, Actionable, Relevant) + DRY + KISS (universal)
                  - write the expected results for the task into the plan
                  - suggest deliverable location(s) under {folder_path} (e.g., docs/decisions/{id}-{slug}.md, docs/research/{id}/, docs/marketing/{id}/, fallback docs/tasks/{id}/)
                - output:
                  - {plan}
                  - {checklist}
                  - {affected_paths} — be inclusive: list every file the plan expects to read, modify, OR create (final paths under {folder_path}, NOT staging paths)
              2. {IF skip_plan_review} move to status "IMPLEMENTING" (auto-approve plan){ELSE} move to status "NEEDS_REVIEW" with {pending_review_kind}="plan"

    - IMPLEMENTING
        - Sonnet cron
          - AI picks
          - on first entry when arriving directly from TODO (skip_plan path): create worktree/workspace + branch lazily (same setup PLANNING would have done; idempotent)
            {IF project.has_repo}
              - operates inside {worktree_path} on {branch} (writes to final paths declared in {affected_paths})
            {ELSE}
              - operates inside {workspace_path} (staging); mirrors the relative structure of final {affected_paths} paths under this dir
            - read {comments} tagged stage=AI-REVIEW or stage=NEEDS_REVIEW since last state transition; address feedback. Otherwise read {plan} and {checklist} to continue the task. Keep {plan} unchanged. Update {checklist}.
            - on finish, before transitioning:
              {IF project.has_repo}
                - refresh {affected_paths} via `git diff --name-only {default_branch}...HEAD` (overwrites prediction with ground truth)
                - commit + push {branch} to origin
              {ELSE}
                - refresh {affected_paths} via recursive scan of {workspace_path} (overwrites prediction with ground truth)
              {IF skip_ai_review}
                - move to status "PUBLISHING" (bypass AI-REVIEW gate; trivial tasks)
              {ELSE}
                - move to status "AI-REVIEW"
              - output
                - task implemented moved to next status
                - follow up and updates goes into the {checklist}
                - {affected_paths} refreshed to actual file list

    - AI-REVIEW:
      - Opus cron
        - AI picks
          - read {plan}, {checklist}, and all {comments} for full context.
          - review task is correctly implemented, no missing parts, no gaps and decide to approve or decline.
              {IF mode=="dev"}
                evaluate against: SOLID, DRY, KISS, YAGNI
              {ELSE} # mode=="non-dev"
                evaluate against: CLEAR (Complete, Legible, Exact, Actionable, Relevant) + DRY + KISS
              {IF approved}
                - move to status "PUBLISHING"
              {ELSE IF ai_auto_actions(task) >= max_ai_decline_cycles}
                - append comment ({stage: "AI-REVIEW", author: "ai", text: "max AI decline cycles reached — deferring to human"})
                - force-move to status "PUBLISHING" (PR will be created so human reviews tangible artifact + all decline comments)
              {ELSE}
                - AI appends comment ({stage: "AI-REVIEW", author: "ai", text: <decline reason>}) → move back to status "IMPLEMENTING"
    - PUBLISHING:
      - Publish policy: {create_pr}/{push_remote}/{merge_to_main}/{draft_pr} resolve per-task → per-project → auto (repo remote). {push_remote} is the master switch (on → PR flow; off → local). {create_pr}=off + push on → push the branch with NO PR ({delivery_url}=`branch:<name>`), direct-to-main on finish. {merge_to_main}=off → krill NEVER merges (approve marks DONE; you merge the PR/branch yourself). {draft_pr} → open a draft (auto-finish suppressed; approve runs `gh pr ready` then squash-merges). {delete_branch_on_done} removes the branch once actually merged.
      - Auto-finish (A2): if {auto_publish}=true AND project {allow_auto_finish}=true, after a clean merge the deliverable gate is SKIPPED and the task goes straight to DONE (no NEEDS_REVIEW(deliverable)). Remote-less repos merge locally and set {delivery_url}=`local:<branch>`. AI-REVIEW still ran upstream. SUPPRESSED when {merge_to_main}=off, the PR is a draft, or push-off would leave a remote behind. If not eligible, the normal deliverable gate below applies. A3 circuit breaker: ≥2 (or ≥30%/1h) auto-finish failures pauses the project; declining cascade-cancels dependents.
      - Blocked (unblock queue): any stage that hits something interactive it can't answer headless (an unauthenticated MCP returns an OAuth URL, or the CLI is logged out) sets {tasks.blocked}=true (claim/picker skips it) and files a `blocker`. A human clears it via the board banner → the next tick re-runs the stage. Stages load USER MCP servers (e.g. Supabase) alongside krill's task tools unless KRILL_STRICT_MCP=1.
      - Deterministic cron (no LLM in the happy path; Sonnet only on conflict + {publishing_solve_conflicts}=true)
        - cron picks claim
          {IF project.has_repo}
            - inside {worktree_path} on {branch}:
              - if PR does not yet exist (check via `gh pr list --head {branch}`):
                - push {branch}
                - open PR against {default_branch} with deterministic template:
                  - title: `{task.id}: {task.name}` (e.g. "AT-2: Fix LP CTAs to signup")
                  - body:
                    ```
                    {plan}

                    ## Checklist (final state)
                    {checklist}

                    ## Implementation notes
                    {comments filtered stage=IMPLEMENTING}
                    ```
                - set {delivery_url} to PR URL
              - idempotent pre-merge sync: `git fetch origin && git reset --hard origin/{branch}` (no-op when in sync; picks up any human-side resolution pushed to GitHub between ticks)
              - attempt: merge origin/{default_branch} INTO {branch} (merge-into, NOT rebase — preserves history, no force-push, keeps reviewer comments anchored)
              - {IF clean merge}
                - push merge commit
                - move to status "NEEDS_REVIEW" with {pending_review_kind}="deliverable"
              - {ELSE conflict}
                {IF {publishing_solve_conflicts}=false}
                  - append comment ({stage: "NEEDS_REVIEW", author: "ai", text: "conflict resolver disabled — resolve in GitHub then click Retry PUBLISHING, or Solve with Sonnet, or send back to IMPLEMENTING: <files>"})
                  - force-move to status "NEEDS_REVIEW" with {pending_review_kind}="conflict" (PR already exists — human resolves in GitHub OR clicks per-task "Solve with Sonnet" CTA)
                {ELSE} # {publishing_solve_conflicts}=true
                  - Sonnet sub-step: attempt conflict resolution
                  - {IF resolved}
                    - push merge commit
                    - move to status "NEEDS_REVIEW" with {pending_review_kind}="deliverable"
                  - {ELSE resolution failed}
                    - append comment ({stage: "NEEDS_REVIEW", author: "ai", text: "conflict resolution failed: <files>"})
                    - {IF ai_auto_actions(task) >= max_ai_decline_cycles}
                      - force-move to status "NEEDS_REVIEW" with {pending_review_kind}="conflict" (PR already exists — human resolves conflicts directly in GitHub)
                    - {ELSE}
                      - keep status="PUBLISHING"; release claim; next cron will retry
          {ELSE} # has_repo=false
            - "publish": move files from {workspace_path} to their final paths under {folder_path} (paths come from {affected_paths}); skip overwrites that collide with existing files unless explicitly listed in {affected_paths}
            - cleanup {workspace_path}
            - set {delivery_url} to file://{folder_path}/<deliverable root path>
            - move to status "NEEDS_REVIEW" with {pending_review_kind}="deliverable"
              (Note: {pending_review_kind}="conflict" is has_repo=true only — non-repo projects have no merge step.)

    - NEEDS_REVIEW (unified gate; replaces former PLAN-REVIEW and HUMAN-REVIEW)
      - Discriminated by {pending_review_kind}:
        - "plan" — entered from PLANNING. Human approves → IMPLEMENTING, declines → PLANNING (with comment), or sends BACKLOG / CANCELED.
        - "deliverable" — entered from PUBLISHING after clean merge (has_repo=true) or workspace publish (has_repo=false). Human approves → DONE (triggers PR squash-merge when has_repo=true; non-repo just marks DONE), declines → IMPLEMENTING (with comment), or sends BACKLOG / CANCELED.
        - "conflict" — entered from PUBLISHING after a merge conflict that the auto path could not (or was not allowed to) resolve. Has_repo=true only. Human can: Retry PUBLISHING (re-runs the deterministic merge step; idempotent pre-merge reset picks up any human-side GitHub resolution); Solve with Sonnet (per-task CTA, hidden when global {publishing_solve_conflicts}=true since the auto path is already handling it — runs the same Sonnet sub-step the cron would run, without incrementing the brake counter); send to IMPLEMENTING for a redo; or BACKLOG / CANCELED.
      - Worktree + workspace are RETAINED across all NEEDS_REVIEW kinds (decline/retry is cheap).
      - {pending_review_kind} is cleared on every NEEDS_REVIEW exit.
      - Human-decline comments are tagged stage=NEEDS_REVIEW; for kinds where a PR exists, the comment is also posted to the PR.
    - DONE
      


  NOTES
  - {updated_at} on tasks updates;
  - Timestamps: {started_at} is set ONCE at first TODO→PLANNING pick (total task duration metric). {stage_entered_at} is RESET on every status transition (current-stage duration metric). Do not conflate.
  - Cancellation: human can move any task to CANCELED at any time. On entry to CANCELED: cleanup worktree (if has_repo) or task workspace (if !has_repo); keep branch around for audit; release claim. CANCELED is terminal — no further cron pickup. To restart, human moves task back to TODO (workflow re-runs from scratch; existing branch/PR reused if still present).
  - Decline-back-to-BACKLOG: human moves any non-terminal task back to BACKLOG. Same cleanup as CANCELED (worktree/workspace destroyed; branch retained). Task re-enters normal queue when human moves it back to TODO.
  - {checklist} is markdown text; free-form notes between checkbox lines are welcome. Track items using the 3-state checkbox convention: `[ ]` todo, `[~]` in progress, `[x]` done. `[~]` matters most — it tells a fresh session what's mid-flight so it can resume vs restart. Same convention is used in build plan docs.
  - All state transitions are atomic: `UPDATE task SET status=NEW, claimed_until=NULL, stage_entered_at=now() WHERE id=? AND status=OLD`. Loser sees 0 rows affected and moves on. Prevents duplicate cron picks.
  - Cron claim is atomic + TTL-locked: `UPDATE tasks SET claimed_until=now()+TTL, claimed_by=$worker WHERE id=(SELECT id FROM tasks WHERE status=$stage AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY priority ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. Worker dies mid-stage → lock expires → next cron picks up. Workers must be re-entrant (re-read {plan}, {checklist}, {comments}, git branch state to resume or redo).
  - Pre-cron checks (in order): {automation_enabled} → {stage_enabled[stage]} → backoff active → per-project {paused}. Any false → cron exits no-op.
  - Stuck-task detection (periodic health query): `status IN (active states) AND claimed_until IS NULL AND now() - stage_entered_at > max_stage_duration[stage]` → log + notify human. Auto-recovery only via lock expiry; no auto-retry loop.
  - PUBLISHING re-run safety: check `gh pr list --head {branch}` before opening PR; if PR exists, skip creation and sync state.
  - AI-driven loop brake (gap 9): `ai_auto_actions(task)` = count of {comments} with author='ai' since the most recent of (any human comment) OR (forward state transition toward DONE), EXCLUDING comments prefixed with the manual-CTA marker `[manual] ` (human-triggered "Solve with Sonnet" runs must not inflate the counter). If `ai_auto_actions >= max_ai_decline_cycles` (default 3), AI MUST NOT make another auto-decline/conflict-failure decision; it force-moves the task to NEEDS_REVIEW(conflict) (creating the PR first if it does not yet exist). Human-driven loops (NEEDS_REVIEW declines, retries) are NOT capped — humans self-regulate.
  - Concurrency model: many projects run in parallel; tasks within a project run in parallel up to {max_parallel_tasks}, isolated by per-task git worktree + branch. Convergence happens at PUBLISHING via merge-into.
  - Status sets (four intent-named constants in schema; each consumer uses the one that fits its question):
    - WORKTREE_RETAINED_STATUSES = {PLANNING, IMPLEMENTING, AI-REVIEW, PUBLISHING, NEEDS_REVIEW} — cleanup gate; worktree/workspace destroyed only on exit from this set.
    - PARALLEL_SLOT_STATUSES = {PLANNING, IMPLEMENTING, AI-REVIEW, PUBLISHING} — counted against {max_parallel_tasks}; NEEDS_REVIEW does NOT occupy a slot (frees it during human review).
    - CONFLICTS_BLOCKING_STATUSES = {PLANNING, IMPLEMENTING, AI-REVIEW, PUBLISHING, NEEDS_REVIEW} — peer-check for {conflicts_with} + MCP affected_paths peer queries; NEEDS_REVIEW still blocks dependents.
    - STUCK_WATCHED_STATUSES = {PLANNING, IMPLEMENTING, AI-REVIEW, PUBLISHING} — stuck-task scanner; NEEDS_REVIEW is human-parked and exempt.
  - Worktree lifecycle (has_repo=true): created at PLANNING start (first entry only), destroyed on every exit from active states (DONE, cancel, decline-back-to-BACKLOG). Branch is kept until DONE/cancel — pause/resume re-creates worktree from branch HEAD cheaply.
  - Task workspace lifecycle (has_repo=false): {workspace_path}={folder_path}/.tasks/{id}/ created at PLANNING start, destroyed at PUBLISHING (after publish) or on cancel/decline-back-to-BACKLOG.
  - {conflicts_with}: AI proposes at PLANNING from {affected_paths} overlap with active peers. Human edits are sticky — AI must not overwrite human-set entries on re-plan.
  - {affected_paths}: predicted at PLANNING end (be inclusive: read/modify/create). For has_repo=true refreshed at IMPLEMENTING end via `git diff --name-only {default_branch}...HEAD`. For has_repo=false refreshed via recursive scan of {workspace_path}. Glob format: `*`, `**`, paths relative to {folder_path}. Always describes FINAL paths, never staging paths.
  - {comments}: append-only. Any actor (human or AI) appends an entry tagged with the stage where it originates. Readers filter by stage tag relevant to their work. Idempotent — AI judges what is already addressed by inspecting {plan} / {checklist}, not by marking comments as resolved. Humans can append at any time (mid-stage nudges welcome). AI comments authored by human-triggered CTAs (e.g., "Solve with Sonnet") carry the `[manual] ` prefix so the loop brake skips them.
  - {mode} ("dev" | "non-dev"): shapes AI prompt direction at PLANNING, IMPLEMENTING, AI-REVIEW. Does NOT control workflow path — workflow path is controlled by project.has_repo.
  - Principle sets per mode:
    - dev: SOLID, DRY, KISS, YAGNI
    - non-dev: CLEAR (Complete, Legible, Exact, Actionable, Relevant) + DRY + KISS (universal)


---

## REVIEW / VERDICT — all 9 gaps resolved

Original verdict: workflow worked as linear single-task pipeline but broke on AI self-review, parallel/dependent tasks, non-dev path at PUBLISHING, race conditions across crons. All addressed below.

### Gaps (ordered by severity)

1. ~~**AI reviews own output**~~ — **RESOLVED**: pinned models per stage. PLANNING=Opus, IMPLEMENTING=Sonnet, AI-REVIEW=Opus, PUBLISHING=deterministic (LLM-free; Sonnet only on merge-conflict resolver sub-step, gated by `{publishing_solve_conflicts}`). TODO picker is deterministic SQL (cron-driven; no model invocation).
2. ~~**No dependency model**~~ — **RESOLVED**: added `{depends_on}: [task_id, ...]`. Hard deps only. Cross-project allowed (ids globally unique via slug prefix). Cycles ignored (human responsibility). Picker skips task if any blocker not DONE.
3. ~~**No concurrency rule**~~ — **RESOLVED**: per-task worktree + branch model. New fields: PROJECTS gets `{default_branch}` (default "main") and `{max_parallel_tasks}` (default 1, range 1-5). TASKS gets `{branch}`, `{worktree_path}`, `{conflicts_with}`, `{affected_paths}`. Global config gets `{worktrees_root}` (default `~/.ai-worktrees/`). Race A fixed via atomic state transitions. Race B fixed via worktree isolation. Intra-project parallelism enabled; convergence at PUBLISHING via merge-into (not rebase). `{conflicts_with}` derived at PLANNING from `{affected_paths}` overlap with active peers (human override sticky). `{affected_paths}` refreshed at IMPLEMENTING end via `git diff --name-only`. Worktree destroyed on exit from active; branch kept until DONE/cancel.
4. ~~**PUBLISHING assumes dev**~~ — **RESOLVED**: workflow path gated on `project.has_repo`, not task mode. PROJECTS gets `{has_repo}` (auto-detected). TASKS adds `{workspace_path}` (used when has_repo=false: staging dir `{folder_path}/.tasks/{id}/`). `{pr_url}` renamed to `{delivery_url}` (PR URL or file:// link). At PUBLISHING: has_repo=true → merge-into + PR; has_repo=false → "publish" staged files to final paths + cleanup workspace. At HUMAN-REVIEW approve: has_repo=true → merge PR; has_repo=false → mark DONE. Renamed `{is_dev}` → `{mode}: "dev" | "non-dev"` (shapes prompts at PLANNING + IMPLEMENTING + AI-REVIEW, not workflow path). Principle sets: dev → SOLID/DRY/KISS/YAGNI; non-dev → CLEAR (Complete, Legible, Exact, Actionable, Relevant) + DRY + KISS. BACKLOG validation: reject task creation if `mode="dev"` and `has_repo=false`.
5. ~~**`{status}` field missing**~~ — **RESOLVED**: added `{status}` enum to TASKS Fields overview with all states: BACKLOG | TODO | PLANNING | PLAN-REVIEW | IMPLEMENTING | AI-REVIEW | PUBLISHING | HUMAN-REVIEW | DONE.
6. ~~**Git lifecycle vague**~~ — **RESOLVED** (fell out of gaps 3 + 4): branch + worktree created at PLANNING start (has_repo only). Commits + push at IMPLEMENTING end. `git fetch` + merge-into `origin/{default_branch}` at PUBLISHING. PR opened at PUBLISHING. PR merged at HUMAN-REVIEW approve. Worktree destroyed on exit from active. Branch retained until DONE/cancel.
7. ~~**Three note fields overlap**~~ — **RESOLVED**: merged `{plan_notes}`, `{implementation_notes}`, `{human_notes}` into single append-only `{comments}: [{at, stage, author, text}]` log. All stages append; readers filter by tag (PLANNING reads PLAN-REVIEW comments, IMPLEMENTING reads AI-REVIEW + HUMAN-REVIEW + inline human, AI-REVIEW reads all for context). Captures inline human nudges at any stage. Idempotent — AI judges resolution by `{plan}` / `{checklist}` state, not comment marks.
8. ~~**Cron cadence + idempotency**~~ — **RESOLVED**: Cadence: TODO 30s, all other stages 60s, staggered start times. Per-stage exponential backoff (30/60/120, cap 300) on API errors, isolated per-stage. Claim via `{claimed_until}` TTL lock (PLANNING/AI-REVIEW/PUBLISHING 5min, IMPLEMENTING 30min); workers must be re-entrant. Kill switches: global `{automation_enabled}`, per-stage `{stage_enabled}`, per-project `{paused}`. Stuck-task detection: compare `{stage_entered_at}` against `{max_stage_duration}`; log + notify, no auto-retry loop. PUBLISHING re-run safety: skip PR creation if already exists.
9. ~~**Infinite review loops**~~ — **RESOLVED**: cap only AI-driven loops (human loops self-regulate). Counter `ai_auto_actions(task)` derived from `{comments}` (no new field) — count of ai-authored comments since last human comment or forward state progress. After `{max_ai_decline_cycles}` (default 3), AI force-moves to HUMAN-REVIEW (creating PR first if needed). Applies to AI-REVIEW declines AND PUBLISHING merge-conflict failures. Also reordered PUBLISHING: open PR FIRST, then attempt merge — guarantees a tangible artifact for the human regardless of merge outcome; if AI cannot resolve conflict, human takes over directly in GitHub.


