# Operational Cost — per task at runtime

Each task moving through the pipeline consumes LLM tokens. This doc estimates per-task cost so capacity / budget can be planned.

Actuals are now metered, not just estimated: every Claude CLI spawn writes a `stage_usage` row (input/output/cache tokens + cost_usd), rolled up into `tasks.tokens_used` and surfaced per-task / per-project / today in the UI. Use the meter to correct the ranges below against your real workload.

## Per stage

| Stage         | Model              | Tokens / pass |
|---------------|--------------------|---------------|
| TODO pick     | none (SQL)         | 0             |
| PLANNING      | Opus               | 30-80k        |
| IMPLEMENTING  | Sonnet             | 100-500k      |
| AI-REVIEW     | Opus               | 20-50k        |
| VERIFYING     | Sonnet (skipped when `{skip_verify}`; default ON non-dev / OFF dev) | 20-80k per pass (runs the change) |
| escalation resolver | Opus (gated by `{escalation_auto_resolve}`; metered under `ai_review`) | 10-40k per fork |
| PUBLISHING    | none (happy path)  | 0             |
| PUBLISHING — conflict resolver | Sonnet (gated by `{publishing_solve_conflicts}`) | 10-30k per conflict pass |
| NEEDS_REVIEW(conflict) — "Solve with Sonnet" CTA (per click) | Sonnet | 10-30k per click (same as auto path; brake counter NOT incremented) |

## Typical totals

| Scenario                                 | Tokens    |
|------------------------------------------|-----------|
| Happy path (no decline, clean merge)     | 150-650k  |
| Happy path + one merge conflict pass     | 160-680k  |
| One AI-REVIEW decline cycle              | 400k-1M   |
| Three decline cycles (gap 9 cap)         | 1-2M      |

## Cost drivers

- IMPLEMENTING dominates — file count + size matters most.
- AI-REVIEW and PLANNING are Opus → ~5x more expensive per token than Sonnet.
- `{comments}` accumulate token cost over time (AI-REVIEW reads all for context).
- Re-runs after worker death repeat partial work — guard with idempotent stage handlers.

## Optimization levers

- Session continuity (V1/V2, 2026-07): an IMPLEMENTING redo resumes its prior
  session, and VERIFYING resumes the implementing session (same model, fresh
  ≤300s) — context arrives as cache reads instead of re-derivation. Verdict
  transitions kick the next stage immediately (event-driven chaining) so warm
  hops stay inside the 5-min cache TTL; the cron remains the fallback.
  AI-REVIEW deliberately never resumes (fresh-eyes review). Kill switch
  KRILL_RESUME=0; `stage_usage.resumed` is the A/B marker. Design record:
  bridge `docs/session-continuity.md`.
- Diff persisted once at IMPLEMENTING end (`diff_text`, capped) — AI-REVIEW and
  VERIFYING read it from task_context() instead of re-deriving the same bytes
  with their own fetch + git diff + file reads.
- Cheap-first review ladder: a task's FIRST AI-REVIEW pass runs Sonnet; Opus
  only once the review is contested (a decline cycle exists). Escalation
  resolver runs Sonnet (its defer path lands on a human anyway). Watch the
  decline-flip rate in stage_usage (model column records what actually ran).
- Static-sufficient approve: AI-REVIEW can pass `static_sufficient=true` for
  fully-static diffs, skipping the VERIFYING spawn it would duplicate.
- `skip_plan=true` for one-liner tasks → bypass plan-writing.
- `skip_plan_review=true` → auto-approve plan; saves the human gate.
- `skip_ai_review=true` for trivial tasks → bypass AI-REVIEW (saves Opus call).
- `skip_verify=true` → bypass VERIFYING (saves a Sonnet run). Auto-on for non-dev and docs-only diffs.
- VERIFYING runs on Sonnet (not Opus) as a measured-cost A/B — keeps the prove-it-runs stage cheap.
- Tight `{affected_paths}` scope → less file IO during IMPLEMENTING.
- Set `{max_parallel_tasks}` per project to throttle burn rate.
- `{publishing_solve_conflicts}=false` → zero LLM tokens at PUBLISHING regardless of conflicts (human resolves in GitHub, or opts in per-task via the "Solve with Sonnet" CTA on NEEDS_REVIEW(conflict)).

## Caveats

- Estimates ±2x. IMPLEMENTING for a >10-file refactor can hit 1M+ by itself.
- Cache hits depend on session length and which files stay warm.
- Operational cost dominates over time. Build cost is one-time.
