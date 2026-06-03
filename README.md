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

Stub Claude ships by default so the spine works without the `claude` CLI.
Flip to real Claude with `CLAUDE_RUNNER=real npm start`.

## Develop (secondary)

Only when changing the app itself. Hot reload, slower, mobile-unfriendly:

```bash
npm run dev
```

## Tests

```bash
npm test
```

19 integration tests covering atomic claim, transitions, eligibility, the
decline brake, and the full BACKLOG → DONE walk against a stub Claude. ~3s.

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
