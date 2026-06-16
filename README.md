<p align="center">
  <img src="public/krill-logo.svg" alt="krill" width="64" height="64"/>
</p>

# krill

Most AI agent tools make you define a goal, connect chat apps, configure a
VPS, or manage cloud accounts. This one doesn't. You already have Claude Code
installed. Point this at a repo, add tasks, and a safe staged pipeline runs
them: plan → human review → implement → AI review → publish. That's it.

No goal-setting. No integrations. No infra. Clone, install, start.

## Why krill?

Krill are tiny crustaceans that sustain the largest animals on earth. This
tool takes the same approach: minimal surface, no cloud, no integrations —
tasks go in, work comes out, you stay in control. The name is the pitch.

---

Tasks flow through a staged pipeline:

```
BACKLOG → TODO → PLANNING → NEEDS_REVIEW(plan) → IMPLEMENTING → AI-REVIEW
        → PUBLISHING → NEEDS_REVIEW(deliverable|conflict) → DONE
```

The harness handles git worktrees, branch + PR ops, atomic claims,
kill switches, and live SSE updates. Claude fills in the plan, the code,
and the review decisions.

### Autonomy & publishing (A1–A3)

- **Publish policy (A1)** — `create_pr` / `push_remote` / `merge_to_main` / `draft_pr`,
  per **project** with optional per-**task** overrides (null = inherit; project null =
  auto-detect from the repo's remote). `push_remote` is the master switch: on → PR flow
  (or, with `create_pr` off, push the branch with **no PR**, direct-to-main on merge);
  off → local merge. `merge_to_main` off → krill **never merges** (you merge the
  PR/branch yourself; approve just marks DONE). `draft_pr` → open drafts (auto-finish
  suppressed; approve marks ready then squash-merges). `delete_branch_on_done` removes
  the branch once actually merged.
- **Auto-finish (A2)** — `auto_publish=true` **and** project `allow_auto_finish=true`
  skips the deliverable gate and merges straight to DONE (double-gated; AI review still
  runs). Suppressed when `merge_to_main` is off, the PR is a draft, or push-off would
  leave a remote behind.
- **Circuit breaker (A3)** — ≥2 (or ≥30% in 1h) auto-finish failures **pauses** the
  project; declining a task **cascade-cancels** its dependents.
- **Blocker queue** — a stage that hits something interactive it can't answer headless
  (MCP auth, CLI login) **pauses the task** (`blocked`; the picker skips it) and files a
  blocker in the board banner. Clear it → the next tick re-runs the stage.
- **MCP** — stages load your **user MCP servers** (e.g. Supabase) alongside krill's task
  tools, so a task can make real external changes. `KRILL_STRICT_MCP=1` isolates to
  krill's tools only. ⚠️ With auto-finish + Ludicrous this lets an autonomous task write
  external systems unattended — opt projects in deliberately.

Publish policy + `auto_publish` are typically set by the upstream strategy layer
([whale](../whale)); krill enforces the gates. Schema: migrations through `0007`
(per-task policy, draft/branch-cleanup, blockers).

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- Node.js 18+
- Git (optional — non-repo projects work too)

## Quick start

Run the production build. It is faster, lighter, and the only mode that
behaves correctly on a phone over LAN (the dev HMR socket misbehaves on
mobile browsers).

```bash
npm install
npm run db:migrate
npm run db:seed
npm run build
npm start
```

Open `http://localhost:3000` (or the LAN URL shown in the footer). The board
is the default page — register a project, then create a task. The autonomous
cron starts on boot; toggle it off any time from `/settings` or via
`PATCH /api/config { "automation_enabled": false }`.

The code default is stub Claude, so the spine works without the `claude` CLI.
Set `CLAUDE_RUNNER=real` (via `.env.local`) to spawn the real CLI per stage — the
bridge fleet runs real this way.

## Develop (secondary)

Only when changing the app itself. Hot reload, slower, mobile-unfriendly:

```bash
npm run dev
```

## Tests

```bash
npm test
```

62 tests covering atomic claim, transitions, eligibility, the decline brake,
publish-policy resolution, the auto-finish path + permission gate, the circuit
breaker, and the full BACKLOG → DONE walk against a stub Claude. ~9s.

## LAN trust model

The server binds `0.0.0.0:3000` with no auth. Run only on trusted home/
office networks. Do not port-forward. The footer surfaces the discovered
LAN URL for phone access.

## Where to read next

- **[RUNBOOK.md](RUNBOOK.md)** — setup, day-to-day ops, mental model of the
  state machine, troubleshooting recipes.
- [OVERVIEW.md](OVERVIEW.md) — workflow source of truth: every field,
  every state, every transition rule.
- [ARCHITECTURE.md](ARCHITECTURE.md) — stack, DB schema, MCP tool surface,
  folder layout.
- [DESIGN.md](DESIGN.md) — UI guide (Ubuntu fonts, semantic accents,
  no decoration).
