# Operational Cost — per task at runtime

Each task moving through the pipeline consumes LLM tokens. This doc estimates per-task cost so capacity / budget can be planned.

## Per stage

| Stage         | Model              | Tokens / pass |
|---------------|--------------------|---------------|
| TODO pick     | none (SQL)         | 0             |
| PLANNING      | Opus               | 30-80k        |
| IMPLEMENTING  | Sonnet             | 100-500k      |
| AI-REVIEW     | Opus               | 20-50k        |
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

- Prompt caching across passes (static `{plan}`, evolving `{checklist}`).
- `skip_plan=true` for one-liner tasks → bypass plan-writing.
- `skip_plan_review=true` → auto-approve plan; saves the human gate.
- `skip_ai_review=true` for trivial tasks → bypass AI-REVIEW (saves Opus call).
- Tight `{affected_paths}` scope → less file IO during IMPLEMENTING.
- Set `{max_parallel_tasks}` per project to throttle burn rate.
- `{publishing_solve_conflicts}=false` → zero LLM tokens at PUBLISHING regardless of conflicts (human resolves in GitHub, or opts in per-task via the "Solve with Sonnet" CTA on NEEDS_REVIEW(conflict)).

## Caveats

- Estimates ±2x. IMPLEMENTING for a >10-file refactor can hit 1M+ by itself.
- Cache hits depend on session length and which files stay warm.
- Operational cost dominates over time. Build cost is one-time.
