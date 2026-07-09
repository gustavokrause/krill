# AI + Human Workflow

Local app that automates a task pipeline via Claude Code CLI. Single-user, local-first, LAN-accessible.

## Read first

- `OVERVIEW.md` — workflow spec (source of truth: fields, states, transitions, rules)
- `ARCHITECTURE.md` — local app architecture (Next.js + SQLite + MCP + SSE + Tailwind + Radix)
- `DESIGN.md` — UI design guide (Ubuntu fonts, semantic accents, no decoration)
- `OPERATIONAL_COST.md` — per-task runtime token estimates

## Workflow at a glance

States: `BACKLOG → TODO → PLANNING → NEEDS_REVIEW(plan) → IMPLEMENTING → AI-REVIEW → VERIFYING → PUBLISHING → NEEDS_REVIEW(deliverable|conflict) → DONE` (plus `CANCELED`). NEEDS_REVIEW is a single status discriminated by `pending_review_kind` (`plan | deliverable | conflict | empty | verify | question | declined | stuck`).

Models per stage: deterministic SQL (TODO pick), Opus (PLANNING; AI-REVIEW only once contested — the first review pass of a task runs Sonnet), Sonnet (IMPLEMENTING, VERIFYING, first AI-REVIEW pass, escalation resolver), deterministic (PUBLISHING happy path — LLM-free; Sonnet only on merge-conflict sub-step gated by `{publishing_solve_conflicts}`). VERIFYING runs the change against `{acceptance}` to prove it works (skipped via `{skip_verify}`, default ON for non-dev / OFF for dev; also auto-set by docs-only diffs or a `static_sufficient` AI-REVIEW approve). Judgment forks auto-resolve via one Sonnet resolver pass (`{escalation_auto_resolve}`, default on; skipped past the per-task escalation cap or when no worktree exists) before parking at NEEDS_REVIEW(question). Token use is metered per stage (`stage_usage` table → `tasks.tokens_used` rollup; `model` records what actually ran).

Modes: `dev` (modifies app code → SOLID/DRY/KISS/YAGNI) vs `non-dev` (everything else → CLEAR + DRY + KISS).

Workflow path gated by `project.has_repo`, not task mode.

## Build order

Spine-first: 01 (scaffold) → 02 (DB) → 03+04 (CRUD + atomic claim, minimal) → 05+06+07 (MCP + runner + stage handlers, stubbed Claude) end-to-end. Then fill out remaining phases.

## Conventions

- 3-state checklist: `[ ]` todo, `[~]` in progress, `[x]` done. Same convention in build plan acceptance + workflow `{checklist}` field.
- Priority enum: `P0` (critical) / `P1` (high) / `P2` (medium, default) / `P3` (low).
- Git commits: Conventional, no auto-amend, no hook skip.
- Docs at repo root.

## Knowledge graph

`graphify-out/` contains a knowledge graph of all docs. For questions about the spec or how components relate, prefer `graphify query "<question>"` over re-reading multiple docs.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
