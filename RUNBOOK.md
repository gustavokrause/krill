# Runbook

Day-to-day operation of the krill harness. This is the doc to
keep open in another tab. For the workflow spec itself read `OVERVIEW.md`;
for stack details read `ARCHITECTURE.md`.

## Contents

- [What this is](#what-this-is)
- [System requirements](#system-requirements)
- [First-time setup](#first-time-setup)
- [Day-to-day commands](#day-to-day-commands)
- [How the state machine actually works](#how-the-state-machine-actually-works)
- [Run modes](#run-modes)
- [Kill switches](#kill-switches)
- [Worktree + branch + PR lifecycle](#worktree--branch--pr-lifecycle)
- [Health, observability, and logs](#health-observability-and-logs)
- [Common ops](#common-ops)
- [Troubleshooting](#troubleshooting)
- [File map](#file-map)

---

## What this is

A single-user, local-first orchestrator. You register projects (folder
paths on your machine, optionally git repos) and create tasks. Tasks move
through a fixed state machine. Each "active" stage corresponds to a Claude
model and a stage handler. Claude reads + writes through an MCP server we
host at `/api/mcp` — never via stdout parsing. The whole loop runs as
node-cron schedules inside the Next.js process.

Single binary in spirit: `npm start` (after `npm run build`) boots the
server, the cron, the SSE pub/sub, and the MCP HTTP bridge in one Node
process backed by one SQLite file (`data/tasks.db` by default). Use
`npm run dev` only when iterating on the app code itself — dev mode
ships HMR/Fast Refresh which is unnecessary for operation and breaks
interactivity on mobile browsers.

## System requirements

| Tool | Version | Required for |
|---|---|---|
| Node.js | ≥ 22 | runtime, built-in `node:test` |
| npm | ≥ 10 | install + scripts |
| git | system default | worktrees, branches, fetch, merge-into |
| `claude` (Claude Code CLI) | ≥ 2.1 | real Claude runs (skip if you stub) |
| `gh` (GitHub CLI) | system default | PR open + merge during PUBLISHING / NEEDS_REVIEW(deliverable) → DONE |

Stub Claude works without `claude`. PR ops fail without `gh auth login`.

## First-time setup (operator path)

This is the path to copy the repo, install once, and use the system.
Build once; restart with `npm start` thereafter. Re-build only after
upgrading the repo (`git pull`).

```bash
# 1) install deps
npm install

# 2) create the SQLite file + apply migrations
npm run db:migrate

# 3) seed the singleton global_config row
npm run db:seed

# 4) (optional) copy env template + tweak
cp .env.local.example .env.local

# 5) build once
npm run build

# 6) boot
npm start
```

Visit `http://localhost:3000`. The footer prints a LAN URL (e.g.
`http://<host-ip>:3000`) — your phone on the same network reaches it
directly. The production build is mandatory for phone use: the dev
server's HMR socket fails on mobile browsers and disables interactive
elements (menus, modals, dropdowns).

To upgrade later:

```bash
git pull
npm install
npm run db:migrate    # only when migrations/ changed
npm run build
npm start
```

### Developer path (secondary)

Only when you are editing the app code and want hot reload. Same prereqs
through step 4, then:

```bash
npm run db:generate   # only when schema.ts changes
npm run dev
```

Do not browse a dev server from your phone — use a production build.

### Environment variables

| Var | Purpose | Default |
|---|---|---|
| `DB_PATH` | SQLite file path (relative to repo root) | `data/tasks.db` |
| `WORKTREES_ROOT` | Per-task worktree root | `~/.ai-worktrees/` |
| `CLAUDE_CODE_VERSION` | Smoke-tested CLI version (informational; surfaced in `/api/health`) | unset |
| `CLAUDE_RUNNER` | `real` spawns `claude`; otherwise stub | unset (= stub) |
| `CRON_DISABLED` | `1` skips node-cron registration (manual ticks only) | unset |
| `PORT` | Bound by `next dev`/`next start` | 3000 |
| `APP_BASE_URL` | Base URL the Claude subprocess uses to reach our MCP server | `http://127.0.0.1:$PORT` |

## Day-to-day commands

```bash
npm start               # boot the production build (operator default)
npm run build           # rebuild after a `git pull` or code edit
npm run dev             # hot-reload dev server (developer only)
npm test                # node:test integration suite
npm run db:studio       # open Drizzle Studio (DB inspector)
npm run typecheck       # tsc --noEmit
```

Manual ticks (with `CRON_DISABLED=1`):

```bash
curl -X POST 'http://127.0.0.1:3000/api/tick?stage=todo_picker'
curl -X POST 'http://127.0.0.1:3000/api/tick?loop=1'    # whole pipeline once
```

Direct API:

```bash
# list projects
curl http://127.0.0.1:3000/api/projects | jq .

# create a project (has_repo auto-detected from folder_path/.git)
curl -X POST http://127.0.0.1:3000/api/projects -H 'content-type: application/json' \
  -d '{"name":"My App","slug":"MA","folder_path":"/path/to/repo"}'

# create a task
curl -X POST http://127.0.0.1:3000/api/tasks -H 'content-type: application/json' \
  -d '{"project_id":"<uuid>","name":"Add bullet","mode":"dev","skip_plan_review":true}'

# transition (e.g., BACKLOG → TODO)
curl -X POST http://127.0.0.1:3000/api/tasks/MA-1/transition \
  -H 'content-type: application/json' -d '{"to":"TODO"}'

# patch global config (kill switch)
curl -X PATCH http://127.0.0.1:3000/api/config -H 'content-type: application/json' \
  -d '{"automation_enabled":false}'
```

## How the state machine actually works

### Models per stage

| Stage | Cron at | Model | What runs |
|---|---|---|---|
| TODO picker | every 30s (:00/:30) | `claude-haiku-4-5-20251001` (informational; deterministic in code) | Atomic claim + transition TODO→PLANNING |
| PLANNING | every 60s (:15) | `claude-opus-4-7` | Worktree/workspace setup, write plan + checklist + affected_paths, transition |
| IMPLEMENTING | every 60s (:45) | `claude-sonnet-4-6` | Code or deliverable edits, commit + push (has_repo) or workspace scan |
| AI-REVIEW | every 60s (:05) | `claude-opus-4-7` | `task_decide("approve"\|"decline")` — transitions driven by the tool |
| PUBLISHING | every 60s (:25) | none in happy path (`claude-sonnet-4-6` only on conflict resolver sub-step, gated by `publishing_solve_conflicts`) | PR-first (`gh pr create` with deterministic title `{task.id}: {task.name}` + body `{plan}`+checklist+IMPLEMENTING comments) → idempotent `git fetch && git reset --hard origin/<branch>` → merge-into → push merge → NEEDS_REVIEW(deliverable) OR (conflict path) Sonnet resolve / force NEEDS_REVIEW(conflict) per toggle + brake |

Stuck scanner runs at `:00` every minute.

### Transition shape

Every transition is atomic:

```sql
UPDATE tasks
   SET status = $to,
       stage_entered_at = unixepoch(),
       updated_at = unixepoch(),
       claimed_until = NULL,
       claimed_by    = NULL
 WHERE id = $id
   AND status = $from
```

Loser sees `changes = 0` and bails out. On success, the cleanup hook fires:

- `worktree-retained → not-retained`: destroy worktree (has_repo) or scrub
  workspace (`!has_repo`, except `PUBLISHING → NEEDS_REVIEW(deliverable)`
  which already moved the files), null out path fields. NEEDS_REVIEW is in
  the worktree-retained set so any decline/retry is cheap.
- `NEEDS_REVIEW(deliverable) → DONE` with a PR URL: `gh pr merge --squash`
  runs **before** the status flip so a merge failure surfaces as 409
  instead of leaving DONE without a merged PR.

### Eligibility filter (TODO picker only)

`claim()` runs in an IMMEDIATE-mode transaction so concurrent calls
serialize on write. For the TODO stage, candidates are filtered by:

1. all `depends_on` ids are status `DONE`
2. no `conflicts_with` task is in `{PLANNING, IMPLEMENTING, AI-REVIEW, PUBLISHING}`
3. project's active count < `max_parallel_tasks`
4. project not paused

Same-priority ties use FIFO (`created_at ASC`).

### Loop brake

`task_decide("decline")` appends an AI comment, then counts AI comments
since the last human comment via `countAiAutoActions`. If the count
reaches `max_ai_decline_cycles` (default 3), the brake fires:

- AI-REVIEW: force-move to PUBLISHING so the human reviews the PR.
- PUBLISHING (conflict resolution failure): force-move to NEEDS_REVIEW(conflict).

Human comments reset the counter. Comments authored by the manual "Solve
with Sonnet" CTA are prefixed with `[manual] ` and excluded from the count.

### Skip flags

| Flag | Effect |
|---|---|
| `skip_plan` | TODO picker routes the task TODO → IMPLEMENTING directly (no PLANNING tick, no plan/checklist, no plan review). Worktree/workspace setup runs lazily on the first IMPLEMENTING entry. Implies `skip_plan_review`. |
| `skip_plan_review` | PLANNING auto-approves; goes IMPLEMENTING instead of NEEDS_REVIEW(plan). No effect when `skip_plan` is also on. |
| `skip_ai_review` | IMPLEMENTING goes PUBLISHING instead of AI-REVIEW. |

## Run modes

| Goal | Command / env |
|---|---|
| Use the system (LAN, phone, daily ops) | `npm run build && npm start` — bare default is stub; persist real with `CLAUDE_RUNNER=real` in `.env.local` (how the bridge fleet runs) |
| Real Claude burn | `CLAUDE_RUNNER=real npm start` — spawns the `claude` CLI per stage |
| Spike walk with no background interference | `CRON_DISABLED=1 npm start` + manual `/api/tick` |
| App-code development with hot reload | `npm run dev` (desktop only — mobile breaks) |
| Tests | `npm test` (sets `DB_PATH=data/test.db`, `CRON_DISABLED=1`) |

## Kill switches

In priority order (first wins):

1. **`automation_enabled`** (`PATCH /api/config`) — every stage exits no-op.
   The toggle is on `/settings`.
2. **`stage_enabled[<stage>]`** (same endpoint) — pause one model lane.
   Example: rate-limited Opus → set `planning=false` and `ai_review=false`.
3. **API-error backoff** — per-stage. Triggered by `RateLimitError` thrown
   by the runner; sequence is `30/60/120` seconds, capped at `300`,
   resets on the first successful tick. State lives in memory.
4. **Project `paused`** (`PATCH /api/projects/{id}`) — `claim()` joins
   projects and skips paused ones for every stage.

## Worktree + branch + PR lifecycle

- **PLANNING (has_repo, first entry)** — `createWorktree` runs
  `git worktree add -b <branch> <path> origin/<default_branch>` rooted
  at the remote default branch. Branch name is
  `<slug>-<N>-<slug-of-task-name>`. Falls back to local default if no
  origin.
- **IMPLEMENTING end (has_repo)** — `commitAll` stages everything dirty
  in the worktree, commits `<TaskId>: <name>`, `pushBranch` sets upstream.
  Then `diffNamesAgainstBase` fetches `origin/<default>` and overwrites
  `affected_paths` with the diff against the remote (avoids local-mirror
  drift; see I-9).
- **PUBLISHING** — deterministic happy path (no LLM). `ensurePr` does
  `gh pr list --head <branch>`, then `gh pr create` if empty with
  template title `{task.id}: {task.name}` and body `{plan}` +
  `## Checklist (final state)` + `## Implementation notes` (comments
  filtered to `stage=IMPLEMENTING`). Sets `delivery_url` to the PR URL.
  `resetWorktreeToOriginBranch` (idempotent `git fetch origin && git reset
  --hard origin/<task-branch>` — picks up any human-side resolution pushed
  to GitHub between ticks) + `mergeOriginInto` merge `origin/<default>`
  INTO the task branch (merge-into, never rebase). Clean merge pushes and
  transitions NEEDS_REVIEW(deliverable). Conflict path: if
  `publishing_solve_conflicts` is false, append comment + force-move to
  NEEDS_REVIEW(conflict) so human resolves in GitHub OR clicks the
  per-task "Solve with Sonnet" CTA; if true, invoke Sonnet conflict
  resolver (`publishing-conflict.md`) — failure releases the claim or
  fires the brake (force NEEDS_REVIEW(conflict) at `max_ai_decline_cycles`).
- **NEEDS_REVIEW(deliverable) → DONE** — transition route runs
  `gh pr merge --squash` BEFORE the status flip; merge failure returns 409.
- **NEEDS_REVIEW(conflict) "Solve with Sonnet"** — `POST
  /api/tasks/{id}/resolve-conflict` claims the task, runs the idempotent
  origin reset, re-recreates the conflict, and reuses the Sonnet
  conflict resolver. Brake counter is NOT incremented (comments prefixed
  with `[manual] `). On success: commit + push + transition back to
  PUBLISHING for re-tick. On failure: leave in NEEDS_REVIEW(conflict).
- **Cleanup** — active → non-active destroys the worktree (`git worktree
  remove --force`). Branch is retained until DONE or CANCELED so
  pause/resume can recreate cheaply.

Non-repo projects use `<folder_path>/.tasks/<id>/` as a staging workspace
that PUBLISHING moves into final paths under `folder_path` (skipping
overwrites unless explicitly listed in `affected_paths`).

## Health, observability, and logs

```bash
# JSON snapshot
curl -s http://127.0.0.1:3000/api/health | jq .
# Live event stream (every mutation)
curl -N http://127.0.0.1:3000/api/stream
# Live SSE listener count
curl -s http://127.0.0.1:3000/api/stream/count
```

The health endpoint reports DB size, per-stage backoff state, project +
task counts, stuck task list (with age vs `max_stage_duration`), SSE
listener count, and the pinned `CLAUDE_CODE_VERSION` env.

Stage logs go to stderr (the `npm start` / `npm run dev` terminal). Look for:

- `[cron] registered ...` once per process boot
- `[cron:<stage>] picked task=<id>` when a stage takes work
- `[cron:<stage>] skipped reason=...` for any kill-switch or no-task tick
- `[stuck] task=... age=...s limit=...s` from the scanner
- `[mcp] <method> task=<id>` per MCP JSON-RPC call
- `[claude:<stage>:<task-id>] exit=... stdout=... stderr=...` per subprocess

Log rotation is not yet implemented (see phase 13 deferred).

## Common ops

### Create a project + first task end-to-end

1. Settings (or `/projects/new`): register the project with a folder path
   and slug (UPPERCASE alphanumeric, starts with a letter).
2. Board → `New task`: pick the project, set mode, optionally enable any
   skip flags.
3. From the task page, hit `TODO`. The cron picks it up on the next
   minute boundary. The board updates live via SSE.
4. If the task lands in NEEDS_REVIEW(plan) (no skip flag), open it and use
   `IMPLEMENTING` to approve (or `PLANNING` to send back with a comment
   for the next pass).
5. AI-REVIEW / PUBLISHING are AI-driven. At NEEDS_REVIEW(deliverable), you
   either `DONE` (merges the PR with squash for has_repo, marks done
   otherwise) or `IMPLEMENTING` (declines with a comment). At
   NEEDS_REVIEW(conflict), choose Retry PUBLISHING (re-runs the
   deterministic merge after picking up any GitHub-side resolution),
   Solve with Sonnet (hidden when `publishing_solve_conflicts=true`), or
   send back to IMPLEMENTING.

### Pause everything immediately

```bash
curl -X PATCH http://127.0.0.1:3000/api/config \
  -H 'content-type: application/json' \
  -d '{"automation_enabled":false}'
```

UI route: toggle the switch at the top of `/settings`. Resumes are equally
fast — no restart needed.

### Pause one project

`PATCH /api/projects/<id> { "paused": true }` or use the toggle on the
project edit page. Active states elsewhere keep running.

### Reset the database

```bash
# stop the server first (prod or dev)
pkill -f "next start"
pkill -f "next dev"
rm -f data/tasks.db data/tasks.db-wal data/tasks.db-shm
npm run db:migrate
npm run db:seed
```

Tasks + projects + comments + global_config are gone. Worktrees on disk
under `~/.ai-worktrees/` are NOT auto-purged; if you want a clean slate:

```bash
rm -rf ~/.ai-worktrees/*
```

### Drop a residue project

```bash
curl -X DELETE http://127.0.0.1:3000/api/projects/<id>
```

FK cascade removes all tasks + comments for that project.

### Tail SSE while you click

```bash
curl -N http://127.0.0.1:3000/api/stream
```

Each mutation emits one `event:` line + one `data:` line; the heartbeat
`: hb <ts>` arrives every 15s.

## Troubleshooting

### `claude` not installed but I want stubs

Default `CLAUDE_RUNNER` is `stub` — nothing to do. Confirm by checking
the stage handler logs (no `[claude:<stage>]` exit lines, only stub-runner
synthetic writes).

### `gh` not authenticated

Symptom: PUBLISHING tick logs `gh pr create` failure with auth message.
Fix: `gh auth login` once on the host.

### Real Claude subprocess hangs

Symptom: stage `claimed_until` keeps approaching expiry without
transition. Likely culprit:

- The CLI prompted for tool-use approval (no TTY). We pass
  `--dangerously-skip-permissions`; if you removed it, restore it.
- The MCP bearer token expired faster than the runner needed it. Token
  TTL matches the stage's claim TTL — check `claim_ttl` in `/api/config`.

If the runner is hung, set `automation_enabled=false`, let the claim
TTL expire, then `kill <pid of claude subprocess>` and re-enable.

### Task stuck forever in PLANNING

Check `/api/health` for the `stuck` array and the task's
`stage_entered_at` vs `max_stage_duration.planning` (default 900s).
Recovery is "human re-claims it":

1. Open the task on the UI.
2. Move it to BACKLOG, then back to TODO. Cleanup hook destroys the
   worktree on the active → non-active transition; PLANNING recreates it
   on the next pick.

If the task is stranded because its **worker died** (see next section), prefer
**Recover** — it re-runs the same stage in the existing worktree instead of
restarting from BACKLOG.

### Orphaned claim after a restart ("worker dead")

A krill restart (or crash) kills every in-flight stage worker, but the task keeps
the dead worker's claim — so it sits in its stage until the claim TTL lapses (the
next tick then re-picks it). The board flags these **"worker dead"** with a
countdown to that self-heal and a **Recover** button.

- **Recover** (UI) or `POST /api/tasks/<id>/recover` force-releases the claim so
  the next stage tick re-picks it immediately. Status is untouched; the worktree
  and its edits are preserved (`ensureWorkspace` is idempotent — the stage re-runs
  and commits whatever's there).
- Detection is by per-boot generation: each claim is stamped with `claim_gen`
  (the process boot id, exposed as `/api/health.boot_id`); a held claim whose
  `claim_gen` ≠ the running boot id was orphaned by a dead process.
- Nothing re-runs unattended beyond the existing TTL self-heal — recovery is
  manual (or you wait out the TTL).

**Avoid creating these**: `npm stop` / `npm run rebuild` (bridge) refuse while any
task holds a live claim (`/api/health.active_claims > 0`) unless `--force`; the
board footer reads **"safe to restart"** when idle.

### MCP auth blocker won't resume from the captured link

An `mcp_auth` blocker's OAuth URL is **single-use and process-scoped** — the
`client_id` is dynamically registered and the `localhost` callback lives in the
worker that already exited, so the saved link is dead on arrival (and isn't shown
as a CTA). Fix: authenticate the MCP **once** in a live interactive session
(`claude` → `/mcp` → authorize); the token caches and the headless runner reuses
it. Then **Resume** the blocker.

### TODO picker is off / nothing gets picked

Most likely a **follow-up** paused it. When a task surfaces out-of-scope work it
seeds a follow-up; krill then comments the origin task, files a persistent
`followup` blocker (with the surfaced content in a read-only textarea), and sets
`stage_enabled.todo_picker = false`. In-flight tasks keep running; only new picks
stop. Clear it on the board: **Resume** on the follow-up blocker re-enables the
picker (`resolveBlocker` special-cases `followup` → `setTodoPickerEnabled(true)`),
**Dismiss** clears the warning but leaves the picker off (re-enable via the toggle).
The warning is its own `blockers` row — independent of whale pulling/consuming the
follow-up — so it persists until you act. If the picker is off with no follow-up
blocker, someone toggled it manually (or via `PATCH /api/config`).

### `SQLITE_BUSY` during heavy mutation

WAL is on, busy_timeout is 5s. If you still see this, it's likely two
processes opening the same DB. Confirm only one server is running:
`lsof -i :3000`.

### Worktree leak (`~/.ai-worktrees/<slug>/<id>/` still present after a task is DONE)

The cleanup hook fires on every successful active → non-active
transition, so a leak means the transition didn't go through cleanly.
Clean by hand:

```bash
cd /path/to/repo
git worktree remove --force ~/.ai-worktrees/<slug>/<id>
git worktree prune
```

### Backoff stuck "on"

The backoff state is in-memory; restart the server to clear it.
You can also patch `api_error_backoff.cap` down via `PATCH /api/config`
to shorten the wait.

### Buttons / menus / modals dead on phone

Symptom: hamburger menu, filter dropdown, confirm dialogs, etc. do not
respond on a mobile browser, but desktop is fine. Cause: you are hitting
the dev server (`npm run dev`). Next.js dev HMR opens a WebSocket back to
the host that mobile browsers fail to complete, which leaves React
without a Fast Refresh runtime and disables interactive handlers. Fix:

```bash
pkill -f "next dev"
npm run build
npm start
```

Use the production build for all phone access. Dev mode is desktop-only.

### `affected_paths` includes upstream files unrelated to the task

Pre-fix I-9 you'd see this when your local default branch lagged origin.
Current code fetches `origin/<default>` and compares against the remote
ref, so the issue should not recur. If it does, run `git fetch --all`
in the project root and try the IMPLEMENTING tick again.

### PR description shows live HTML tags

Pre-fix I-10. Current code wraps user-authored task descriptions in
fenced code blocks. If you still see live HTML, the description ran
through the old code path — recreate the task.

## File map

```
/
├── ARCHITECTURE.md         — stack + DB schema reference
├── DESIGN.md               — UI guide
├── OVERVIEW.md             — workflow spec (source of truth)
├── OPERATIONAL_COST.md     — token cost estimates
├── README.md               — landing page
├── RUNBOOK.md              — this doc
├── drizzle.config.ts
├── next.config.mjs
├── tailwind.config.ts
├── src/
│   ├── app/                — Next.js App Router (UI + API routes)
│   │   ├── api/
│   │   │   ├── config/route.ts        — global_config GET/PATCH
│   │   │   ├── health/route.ts        — JSON health snapshot
│   │   │   ├── mcp/route.ts           — MCP JSON-RPC over HTTP
│   │   │   ├── projects/...           — project CRUD
│   │   │   ├── stream/route.ts        — SSE event channel
│   │   │   ├── stream/count/route.ts  — live listener count
│   │   │   ├── tasks/...              — task CRUD + transition + comments
│   │   │   └── tick/route.ts          — manual tick endpoint
│   │   ├── error.tsx                  — global error boundary
│   │   ├── not-found.tsx              — 404 shell
│   │   ├── page.tsx                   — board
│   │   ├── projects/, settings/, tasks/  — page trees
│   ├── claude/
│   │   ├── errors.ts                  — RateLimitError, TimeoutError, McpAuthError
│   │   ├── mcp-auth.ts                — per-invocation bearer tokens
│   │   ├── mcp-config.ts              — generates --mcp-config JSON (task server; user MCP also loads unless KRILL_STRICT_MCP=1)
│   │   ├── mcp-server.ts              — TOOL_REGISTRY (JSON-RPC dispatch)
│   │   ├── mcp-tools.ts               — task_context/set_plan/set_checklist/...
│   │   ├── model-map.ts               — Stage → model id
│   │   ├── prompts/                   — per-stage prompts (dev + non-dev)
│   │   ├── runner.ts                  — RealClaudeRunner (spawn)
│   │   ├── stub-runner.ts             — scripted stub for spike + tests
│   │   └── index.ts                   — getRunner() / setRunner()
│   ├── components/                    — UI primitives + page-level components
│   ├── db/
│   │   ├── client.ts                  — better-sqlite3 + WAL + FK
│   │   ├── defaults.ts                — DEFAULT_* config values
│   │   ├── migrate.ts                 — migration runner
│   │   ├── migrations/                — drizzle SQL output (committed)
│   │   ├── schema.ts                  — table definitions, enums, types
│   │   └── seed.ts                    — global_config singleton
│   ├── git/                           — worktree/branch/merge/pr/diff/exec/errors
│   ├── lib/
│   │   ├── api/                       — errors.ts, util.ts, validation.ts
│   │   ├── client/                    — api.ts, use-event-source.ts
│   │   ├── events.ts                  — WorkflowEvent union
│   │   ├── health.ts                  — health snapshot
│   │   ├── lan.ts                     — LAN URL discovery
│   │   ├── sse.ts                     — broadcast/subscribe singleton
│   │   └── utils.ts                   — cn()
│   └── workflow/
│       ├── backoff.ts                 — per-stage exponential backoff
│       ├── boot.ts                    — module-load cron registration
│       ├── claim.ts                   — atomic claim + paused-project filter
│       ├── cleanup.ts                 — active→non-active side-effect hook
│       ├── cron.ts                    — node-cron registration
│       ├── eligibility.ts             — deps/conflicts/parallel/paused
│       ├── loop-brake.ts              — countAiAutoActions
│       ├── stages/
│       │   ├── ai-review.ts
│       │   ├── context.ts
│       │   ├── implementing.ts
│       │   ├── planning.ts
│       │   ├── publishing.ts
│       │   └── todo-picker.ts
│       ├── stuck.ts                   — stuck-task scanner
│       ├── tick.ts                    — pre-checks + dispatch
│       ├── transition.ts              — atomic transitionStatus + SSE
│       └── types.ts                   — Stage union, STAGES, now()
└── tests/
    ├── helpers/setup.ts               — test DB bootstrap + factories
    └── integration/                   — 5 test files (19 tests)
```
