import { test } from "node:test";
import assert from "node:assert/strict";
import { __parseUsageResponse } from "@/claude/limits-oauth";

// Captured live from api.anthropic.com/api/oauth/usage 2026-07-28 (trimmed).
const REAL_BODY = JSON.stringify({
  five_hour: { utilization: 25.0, resets_at: "2026-07-28T15:00:00.088001+00:00" },
  seven_day: { utilization: 15.0, resets_at: "2026-07-31T20:00:00.088024+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 25, severity: "normal", resets_at: "2026-07-28T15:00:00.088001+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 15, severity: "normal", resets_at: "2026-07-31T20:00:00.088024+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 9, severity: "normal", resets_at: "2026-07-31T20:00:00.088310+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
});

test("oauth usage parse: real /api/oauth/usage shape maps to limit rows", () => {
  const rows = __parseUsageResponse(REAL_BODY);
  assert.ok(rows);
  assert.equal(rows.length, 3);
  const session = rows.find((r) => r.scope === "session_5h");
  assert.equal(session?.used_pct, 25);
  assert.ok(session?.resets_at && session.resets_at > 1_700_000_000);
  const weeklyAll = rows.find((r) => r.scope === "week" && r.model_bucket === null);
  assert.equal(weeklyAll?.used_pct, 15);
  const fable = rows.find((r) => r.model_bucket === "Fable");
  assert.equal(fable?.scope, "week");
  assert.equal(fable?.used_pct, 9);
  assert.ok(rows.every((r) => r.source === "oauth"));
});

test("oauth usage parse: falls back to five_hour/seven_day when limits[] absent", () => {
  const rows = __parseUsageResponse(JSON.stringify({
    five_hour: { utilization: 40, resets_at: "2026-07-28T15:00:00Z" },
    seven_day: { utilization: 20, resets_at: "2026-07-31T20:00:00Z" },
  }));
  assert.equal(rows?.length, 2);
  assert.equal(rows?.find((r) => r.scope === "session_5h")?.used_pct, 40);
});

test("oauth usage parse: garbage returns null (ladder falls through)", () => {
  assert.equal(__parseUsageResponse("not json"), null);
  assert.equal(__parseUsageResponse("{}"), null);
});
