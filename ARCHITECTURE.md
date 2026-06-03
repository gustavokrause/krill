
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
  │   │   ├── claim.ts         # atomic claim + transition primitives
  │   │   ├── eligibility.ts   # deps + conflicts + max_parallel filter
  │   │   ├── stuck.ts         # stuck-task detection job
  │   │   └── stages/
  │   │       ├── todo-picker.ts
  │   │       ├── planning.ts
  │   │       ├── implementing.ts
  │   │       ├── ai-review.ts
  │   │       └── publishing.ts
  │   ├── claude/
  │   │   ├── runner.ts        # spawn `claude` subprocess
  │   │   ├── mcp-server.ts    # MCP tools exposed to Claude
  │   │   └── prompts/         # per-stage prompts (dev + non-dev variants)
  │   ├── git/
  │   │   ├── worktree.ts      # create / destroy worktrees
  │   │   ├── branch.ts        # create / push branches
  │   │   ├── merge.ts         # fetch + merge-into + conflict detection
  │   │   └── pr.ts            # gh pr create / merge
  │   ├── lib/
  │   │   ├── sse.ts           # SSE broadcaster (in-memory pub/sub)
  │   │   ├── logger.ts
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

  projects
    - id (uuid)
    - name, slug (unique)
    - folder_path
    - has_repo (bool)
    - default_branch
    - max_parallel_tasks
    - paused

  tasks
    - id (string, "{slug}-{N}")
    - project_id (fk)
    - name, description
    - priority (enum: "P0" | "P1" | "P2" | "P3", default "P2")
    - status (enum)
    - mode ("dev" | "non-dev")
    - plan, checklist (text)
    - depends_on (json array of task ids)
    - conflicts_with (json array)
    - affected_paths (json array)
    - branch, worktree_path, workspace_path
    - delivery_url
    - skip_plan, skip_plan_review, skip_ai_review
    - claimed_until, claimed_by
    - created_at, started_at, stage_entered_at, updated_at, ended_at

  comments (append-only)
    - id (uuid)
    - task_id (fk)
    - at (timestamp)
    - stage (enum)
    - author ("human" | "ai")
    - text (text)

  Indexes:
    - tasks(status, claimed_until) for claim queries
    - tasks(project_id, status) for project active count
    - comments(task_id, at)


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
    '--model', MODEL_BY_STAGE[stage],            // claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
    '--cwd', task.worktree_path || task.workspace_path || project.folder_path,
    '--mcp-config', mcpConfigPath,                // tells Claude how to reach our MCP server
    '--print',                                    // non-interactive
    '--input-format', 'text'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdin.write(prompt);
  child.stdin.end();
  ```

  - One subprocess per claim. Lifecycle bounded by claim TTL.
  - On TTL expiry, parent kills subprocess (SIGTERM, then SIGKILL).
  - Stdout captured for debug/audit only — authoritative I/O is MCP.


-- MCP SERVER (tools exposed to Claude) --

  - task_context()                       → task, project, plan, checklist, comments, affected_paths, peers' affected_paths, branch state
  - task_set_plan(text)
  - task_set_checklist(text)
  - task_set_affected_paths(paths: string[])
  - task_append_comment(stage, text)
  - task_decide(outcome: "approve" | "decline", reason?: text)

  Each tool validates write authority by stage (e.g., task_decide only valid in AI-REVIEW). Writes are transactional. SSE broadcaster fires on each mutation.


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
      - stage_enabled (5 toggles)
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
