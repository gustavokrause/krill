
AI + HUMAN WORKFLOW — LOCAL APP ARCHITECTURE (v1)

Implements the workflow defined in OVERVIEW.md. Single-user, local-first.


-- DESIGN PRINCIPLES (apply to all code) --

  SOLID, DRY, KISS, YAGNI. No premature abstraction. No multi-user / auth /
  cloud sync until proven needed. Single process, single DB file.


-- GOALS / NON-GOALS --

  Goals:
    - Operate the workflow locally without internet (Claude Code CLI handles AI)
    - Live UI updates as state changes (SSE)
    - Robust crons with TTL locks + kill switches (from gap 8)
    - Atomic state transitions (gap 3 races)
    - Responsive UI — desktop and mobile (use phone to monitor / nudge while away from computer)
    - LAN-accessible — bind to 0.0.0.0 so phone/tablet on same WiFi can reach the app at http://<host-ip>:3000
    - Pair well with Claude Code remote sessions (user may run Claude Code on a remote machine; our app is a separate orchestrator)

  Non-goals (v1):
    - Multi-user / auth (LAN trust model — anyone on the WiFi can reach the app)
    - Internet exposure (no port-forwarding; LAN only)
    - Cloud sync
    - Headless daemon mode (later: launchd/systemd)


-- STACK --

  Runtime          : Node.js (TypeScript)
  Web framework    : Next.js (App Router) — UI + API routes one process
  DB               : SQLite via Drizzle ORM (file-based, transactional)
  Cron             : node-cron (in-process scheduler)
  AI executor      : Claude Code CLI (spawned per stage); no SDK
  Structured I/O   : MCP server exposed by our app; Claude calls tools to read/write task state
  Git              : simple-git + `gh` CLI
  Live UI          : SSE (Server-Sent Events) from /api/stream
  UI styling       : Tailwind CSS (responsive — mobile-first breakpoints)
  UI primitives    : Radix UI full pack (Dialog, DropdownMenu, Tabs, Toast, Tooltip, etc.) — all keyboard + touch accessible
  Network bind     : 0.0.0.0:3000 — accessible from any device on the same LAN (phone, tablet) at http://<host-ip>:3000


-- FOLDER LAYOUT --

  /
  ├── package.json
  ├── tsconfig.json
  ├── tailwind.config.ts
  ├── drizzle.config.ts
  ├── next.config.mjs
  ├── docs/
  │   ├── OVERVIEW.md          # workflow spec (source of truth)
  │   └── ARCHITECTURE.md      # this doc
  ├── src/
  │   ├── app/                 # Next.js App Router
  │   │   ├── (board)/         # Task board UI
  │   │   ├── projects/        # Projects config UI
  │   │   ├── settings/        # Global config, kill switches
  │   │   ├── api/             # REST + SSE endpoints
  │   │   │   ├── tasks/
  │   │   │   ├── projects/
  │   │   │   ├── config/
  │   │   │   └── stream/      # SSE feed
  │   │   └── layout.tsx
  │   ├── components/          # Reusable UI (Radix + Tailwind)
  │   ├── db/
  │   │   ├── schema.ts        # Drizzle schema (mirrors OVERVIEW.md fields)
  │   │   ├── migrations/
  │   │   └── client.ts
  │   ├── workflow/
  │   │   ├── cron.ts          # node-cron registration + tick dispatch
  │   │   ├── tick.ts          # per-stage tick (claim → handler → release)
  │   │   ├── claim.ts         # atomic claim + transition primitives
  │   │   ├── transition.ts    # legal status transitions + pending_review_kind invariant
  │   │   ├── eligibility.ts   # deps + conflicts + max_parallel filter
  │   │   ├── escalation.ts    # judgment-fork auto-resolver (Sonnet; worktree-only — defers to human when no isolated cwd); parks NEEDS_REVIEW(question)
  │   │   ├── loop-brake.ts    # ai_auto_actions counter + max_ai_decline_cycles
  │   │   ├── blockers.ts      # unblock queue (MCP auth / CLI login)
  │   │   ├── followups.ts     # krill → whale follow-up feedback
  │   │   ├── boot-id.ts       # process boot id for orphaned-claim recovery
  │   │   ├── stuck.ts         # stuck scanner: notify → force-park NEEDS_REVIEW(stuck) past 3× cap; releases orphaned claims
  │   │   ├── worktree-gc.ts   # orphaned-worktree GC (hourly + boot sweep)
  │   │   └── stages/
  │   │       ├── todo-picker.ts
  │   │       ├── planning.ts
  │   │       ├── implementing.ts
  │   │       ├── ai-review.ts
  │   │       ├── verify.ts    # VERIFYING: run the change, prove acceptance (Sonnet)
  │   │       └── publishing.ts
  │   ├── claude/
  │   │   ├── runner.ts        # spawn `claude` subprocess (adds --resume when resume.ts picks a session)
  │   │   ├── resume.ts        # session-continuity policy: V1 impl/verify retry + V2 impl→verify resume (same model, ≤300s); AI-REVIEW never resumes; KRILL_RESUME=0 kill switch
  │   │   ├── model-map.ts     # MODEL_BY_STAGE (per-stage model id)
  │   │   ├── usage.ts         # record per-stage token usage → stage_usage + tasks.tokens_used
  │   │   ├── mcp-server.ts    # MCP tools exposed to Claude
  │   │   └── prompts/         # per-stage prompts (dev + non-dev variants; verify-*, resolve)
  │   ├── git/
  │   │   ├── worktree.ts      # create / destroy worktrees
  │   │   ├── branch.ts        # create / push branches; commitAll unstages krill-run artifacts (node_modules, .playwright-mcp)
  │   │   ├── merge.ts         # fetch + merge-into + conflict detection
  │   │   └── pr.ts            # gh pr create / merge
  │   ├── lib/
  │   │   ├── sse.ts           # SSE broadcaster (in-memory pub/sub)
  │   │   ├── logger.ts
  │   │   ├── usage-rollups.ts # per-task / per-project / today token rollups
  │   │   ├── tool-log.ts      # per-MCP-tool-call instrument (tool_calls table)
  │   │   ├── health.ts        # stuck/blocked/orphaned-claim + tokens-today health query
  │   │   └── config.ts        # global config reader/writer
  │   └── types/
  └── data/
      └── tasks.db             # SQLite (gitignored)


-- DB SCHEMA (Drizzle, conceptual) --

  global_config (singleton row, k/v shape)
    - worktrees_root
    - automation_enabled
    - stage_enabled (json)
    - cron_cadence (json)
    - max_stage_duration (json)
    - claim_ttl (json)
    - backoff (json)
    - max_ai_decline_cycles
    - publishing_solve_conflicts (bool)
    - escalation_auto_resolve (bool, default true)

  projects
    - id (uuid)
    - name, slug (unique)
    - folder_path
    - has_repo (bool)
    - default_branch
    - max_parallel_tasks
    - paused
    - create_pr, push_remote, merge_to_main (bool|null — publish policy; null = auto-detect from remote)
    - draft_pr (bool), delete_branch_on_done (bool), allow_auto_finish (bool)
    - pr_description_source (enum: "plan" | "summary", default "plan")

  tasks
    - id (string, "{slug}-{N}")
    - project_id (fk)
    - name, description
    - priority (enum: "P0" | "P1" | "P2" | "P3", default "P2")
    - status (enum, includes VERIFYING)
    - pending_review_kind (enum|null: plan | deliverable | conflict | empty | verify | question | declined | stuck; non-null iff status=NEEDS_REVIEW)
    - mode ("dev" | "non-dev")
    - plan, plan_summary, checklist (text)
    - acceptance (text|null — definition-of-done for VERIFYING; null falls back to plan+checklist)
    - expected_impact (text|null — value-ledger hypothesis written at plan time; informational, never a gate; leads the PR body when set)
    - measured_impact (text|null — JSON [{metric, before?, after, source}] VERIFYING actually observed, via task_verify's measurements param)
    - session_map (text|null — JSON {stage: {id, model, at}}: last claude session per stage, consumed by claude/resume.ts for warm resumes)
    - depends_on (json array of task ids)
    - conflicts_with (json array)
    - affected_paths (json array)
    - diff_text (text|null — unified diff vs base captured at IMPLEMENTING end, capped 150k chars; served as `diff` by task_context)
    - branch, worktree_path, workspace_path
    - delivery_url
    - skip_plan, skip_plan_review, skip_ai_review, skip_verify (bool)
    - auto_publish (bool)
    - create_pr, push_remote, merge_to_main, draft_pr (bool|null — per-task publish-policy overrides)
    - escalation (json|null — open judgment-fork record)
    - blocked (bool — paused on an interactive block)
    - est_tokens (int|null), tokens_used (int — running sum of stage_usage)
    - claimed_until, claimed_by, claim_gen (boot id for orphaned-claim recovery)
    - created_at, started_at, stage_entered_at, updated_at, ended_at

  comments (append-only)
    - id (uuid)
    - task_id (fk)
    - at (timestamp)
    - stage (enum)
    - author ("human" | "ai")
    - text (text)

  stage_usage (append-only token meter — one row per claude CLI spawn)
    - id, task_id (fk), project_id (denormalized), stage, model
    - input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
    - cost_usd, num_turns, duration_ms, created_at
    - resumed (0|1 — this run resumed a prior session; the A/B marker for session continuity: GROUP BY resumed vs tokens/cost)
    - (escalation-resolver runs are recorded under stage "ai_review")

  tool_calls (append-only — one row per krill MCP tool call; shows the bookkeeping share of a stage's turns)

  blockers (unblock queue)
    - id, source, kind (mcp_auth | cli_login | permission | other), status (open | resolved | dismissed)
    - task_id, stage, summary, detail, action_url, created_at, resolved_at

  followups (krill → whale feedback — out-of-scope work a stage noticed but didn't do)
    - id, task_id, project_id, title, description, status (open | consumed), created_at, consumed_at

  Indexes:
    - tasks(status, claimed_until) for claim queries
    - tasks(project_id, status) for project active count
    - comments(task_id, at)
    - stage_usage(task_id), stage_usage(project_id), stage_usage(created_at) for token rollups


-- ATOMIC CLAIM (primitive) --

  ```sql
  UPDATE tasks
  SET claimed_until = unixepoch() + $ttl,
      claimed_by    = $worker_id
  WHERE id = (
    SELECT id FROM tasks
    WHERE status = $stage
      AND (claimed_until IS NULL OR claimed_until < unixepoch())
      AND -- eligibility filter (TODO picker only)
        (
          $stage <> 'TODO' OR (
            NOT EXISTS (SELECT 1 FROM tasks d WHERE d.id IN $depends_on AND d.status <> 'DONE')
            AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.id IN $conflicts_with AND c.status IN $active_states)
            AND (SELECT COUNT(*) FROM tasks p WHERE p.project_id = tasks.project_id AND p.status IN $active_states) < $max_parallel_tasks
          )
        )
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  )
  RETURNING *;
  ```

  Loser sees 0 rows. SQLite uses BEGIN IMMEDIATE for write-lock serialization.


-- CRON TICK (per stage) --

  ```ts
  async function tick(stage: Stage) {
    const cfg = await getConfig();
    if (!cfg.automation_enabled) return;
    if (!cfg.stage_enabled[stage]) return;
    if (isBackoffActive(stage)) return;

    const task = await claim(stage);            // atomic
    if (!task) return;

    try {
      await stageHandlers[stage](task);          // runs Claude + MCP I/O
    } catch (err) {
      if (isRateLimit(err)) bumpBackoff(stage);
      logger.error({ task_id: task.id, stage, err });
    }
  }
  ```

  Register via node-cron with cadence from global_config; stagger start offsets (:00, :15, :30, :45).

  Event-driven chaining: verdict-driven transitions (implementing done,
  task_decide approve/decline, task_verify fail) also call kickStage() —
  fire-and-forget tick(nextStage) — so chained stages run seconds apart and
  same-model hops stay inside the prompt-cache TTL for session resumes.
  The cron cadence above is the fallback, not the pacer; the kicked tick
  carries all the normal guards (claim, stage_enabled, backoff).


-- STAGE HANDLER PATTERN --

  Each handler is re-entrant. On entry:
    1. Read task + project context from DB.
    2. (PLANNING first entry) create branch + worktree OR mkdir task workspace.
    3. Build stage-specific prompt (template by mode dev/non-dev).
    4. Spawn `claude` subprocess with prompt + cwd + model flag + MCP server endpoint.
    5. Subprocess runs; calls our MCP tools to read context + write outputs.
    6. On subprocess exit:
        a. Validate outputs (plan present? affected_paths set?).
        b. Run stage-specific finalization (e.g., IMPLEMENTING end: git diff for affected_paths refresh, commit, push).
        c. Decide next status (respecting skip flags, ai_auto_actions brake).
        d. Atomic transition.
    7. Release claim (transition clears claimed_until).


-- CLAUDE SUBPROCESS RUNNER --

  ```ts
  spawn('claude', [
    '--model', MODEL_BY_STAGE[stage],            // opus-4-7: PLANNING, contested AI-REVIEW; sonnet-4-6: first-pass AI-REVIEW, IMPLEMENTING, VERIFYING, escalation resolver, PUBLISHING conflict resolver
    '--cwd', task.worktree_path || task.workspace_path || project.folder_path,
    '--mcp-config', mcpConfigPath,                // our task MCP server (task_set_plan/decide/…)
    // NOTE: NOT --strict-mcp-config by default — your USER MCP servers (e.g.
    // Supabase from ~/.claude.json) load too, so a stage can make real external
    // changes. Set KRILL_STRICT_MCP=1 to isolate to only the task server above.
    '--print',                                    // non-interactive
    '--input-format', 'text'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdin.write(prompt);
  child.stdin.end();
  ```

  - One subprocess per claim. Lifecycle bounded by claim TTL.
  - On TTL expiry, parent kills subprocess (SIGTERM, then SIGKILL).
  - Stdout captured for debug/audit only — authoritative I/O is MCP.
  - Session continuity: when claude/resume.ts picks an eligible prior session
    (same model, ≤300s fresh; IMPLEMENTING retries + VERIFYING only — never
    AI-REVIEW), the spawn adds `--resume <session-id>` and the run is marked
    stage_usage.resumed=1. KRILL_RESUME=0 forces cold spawns everywhere.


-- MCP SERVER (tools exposed to Claude) --

  - task_context()                       → task, project, plan, checklist, comments, affected_paths, diff (unified diff vs base — review/verify read this instead of re-running git diff), peers' affected_paths, branch state
  - task_set_plan(text)
  - task_set_plan_summary(text)          → PLANNING writes the short plan summary
  - task_set_plan_bundle(...)            → PLANNING batches plan + plan_summary + checklist + affected_paths in one call
  - task_set_checklist(text)
  - task_set_affected_paths(paths: string[])
  - task_append_comment(stage, text)
  - task_decide(outcome: "approve" | "decline", reason?: text, static_sufficient?: bool)   → AI-REVIEW (static_sufficient approve = fully-static diff → skip VERIFYING unless the human set skip_verify explicitly)
  - task_verify(verdict: "pass" | "fail", reason?: text, measurements?: [{metric, before?, after, source}])   → VERIFYING (measurements = observed before/after numbers, stored in tasks.measured_impact; never gates pass/fail)
  - task_resolve(decision)                                       → escalation auto-resolver picks an option

  Each tool validates write authority by stage (e.g., task_decide only valid in AI-REVIEW, task_verify only in VERIFYING). Writes are transactional. SSE broadcaster fires on each mutation. Per-stage model ids live in `src/claude/model-map.ts` (MODEL_BY_STAGE).


-- LIVE UI (SSE) --

  - /api/stream is an SSE endpoint. Subscribers get JSON events on:
      - task.updated
      - task.transitioned
      - comment.appended
      - config.changed
  - In-memory pub/sub (`EventEmitter`). Single-process so no cross-process bus needed.
  - UI client uses `EventSource` to subscribe and update local store.
  - SSE works over LAN to phones/tablets — same EventSource API on mobile browsers.


-- RESPONSIVE / MOBILE UI --

  - Tailwind mobile-first: design at sm: (single column, larger tap targets) first, scale up via md:/lg:.
  - Radix primitives are touch-friendly out of the box; pair with `min-h-11` (44px) tap targets.
  - Task board: phone layout = single vertical column with status filter chips. Desktop layout = multi-column kanban (one column per status).
  - Settings + project config screens use Radix Dialog/Sheet for mobile-friendly modals.
  - Avoid hover-only affordances — every action has a tap-visible control.
  - Test against real phone via http://<host-ip>:3000 during development.


-- NETWORK / LAN EXPOSURE --

  - Next.js launched with `next dev -H 0.0.0.0` (dev) or `next start -H 0.0.0.0` (prod-like) so server binds to all interfaces.
  - Discover host IP for the UI footer ("LAN URL: http://192.168.x.x:3000") to help phone access.
  - Security model: LAN trust. App assumes any device on the same WiFi is the same user. Do NOT port-forward or expose to internet (no auth in v1).
  - If user roams to a coffee-shop WiFi, the app is reachable to that network — recommend running on a trusted home/office network only.


-- KILL SWITCHES (UI controls) --

  - Settings page exposes:
      - automation_enabled (global toggle)
      - stage_enabled (per-stage toggles, incl. verify)
      - per-project paused (toggle per project)
      - rate-limit backoff state (read-only)
  - Toggling writes to global_config; SSE notifies UI; next cron tick reads new state.


-- DEPENDENCIES (npm) --

  next, react, react-dom
  typescript, @types/node
  drizzle-orm, better-sqlite3
  node-cron
  simple-git
  zod (input validation)
  tailwindcss, postcss, autoprefixer
  @radix-ui/react-* (full pack: dialog, dropdown-menu, tabs, toast, tooltip, popover, select, switch, accordion, alert-dialog, etc.)
  lucide-react (icons)
  clsx, tailwind-merge (cn helper)
  @modelcontextprotocol/sdk (MCP server)


-- IMPLEMENTATION ORDER (suggested) --

  1. Drizzle schema + migrations + seed
  2. CRUD API + minimal task board UI (no AI yet)
  3. Atomic claim + state transition primitives + tests
  4. MCP server with read-only tools
  5. Claude subprocess runner + one stage handler (PLANNING)
  6. Remaining stage handlers
  7. Git ops (worktree, branch, merge, PR)
  8. SSE live updates
  9. Kill switches + stuck-task detection
  10. Polish UI (Radix + Tailwind components)


-- OPEN / DEFERRED --

  - Headless daemon mode (launchd/systemd) for autonomous overnight runs
  - Metrics / observability dashboard
  - Multi-machine sync (likely never; single-user local is the design)
  - Binary deliverables (git LFS) for non-dev tasks
  - Notification channels (Slack, native macOS notifications) for stuck tasks
