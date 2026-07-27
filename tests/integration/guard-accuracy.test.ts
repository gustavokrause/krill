import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cleanData, db, tables } from "../helpers/setup";
import { computeGuardAccuracy } from "@/lib/guard-accuracy";

function insertUsageLimit(opts: {
  source: "cli" | "oauth" | "estimate";
  scope: string;
  model_bucket: string | null;
  used_pct: number;
  observed_at: number;
}) {
  db.insert(tables.usageLimits)
    .values({
      id: randomUUID(),
      source: opts.source,
      scope: opts.scope,
      model_bucket: opts.model_bucket,
      used_pct: opts.used_pct,
      resets_at: null,
      observed_at: opts.observed_at,
      raw: null,
    })
    .run();
}

function insertGuardBlocker(opts: {
  kind: string;
  detail: object;
  created_at: number;
}) {
  db.insert(tables.blockers)
    .values({
      id: randomUUID(),
      source: "krill",
      kind: opts.kind,
      status: "open",
      task_id: null,
      stage: null,
      summary: "test blocker",
      detail: JSON.stringify(opts.detail),
      action_url: null,
      created_at: opts.created_at,
      resolved_at: null,
    })
    .run();
}

beforeEach(() => {
  cleanData();
});

// -- Drift --

test("drift: paired session_5h estimate+cli yields correct delta_pct", () => {
  const now = Math.floor(Date.now() / 1000);
  const at = now - 100;

  insertUsageLimit({ source: "estimate", scope: "session_5h", model_bucket: null, used_pct: 60, observed_at: at });
  insertUsageLimit({ source: "estimate", scope: "session_5h", model_bucket: null, used_pct: 60, observed_at: at });
  insertUsageLimit({ source: "estimate", scope: "session_5h", model_bucket: null, used_pct: 60, observed_at: at });

  insertUsageLimit({ source: "cli", scope: "session_5h", model_bucket: null, used_pct: 70, observed_at: at });
  insertUsageLimit({ source: "cli", scope: "session_5h", model_bucket: null, used_pct: 70, observed_at: at });
  insertUsageLimit({ source: "cli", scope: "session_5h", model_bucket: null, used_pct: 70, observed_at: at });

  const result = computeGuardAccuracy(now);

  const bucket = result.drift.find((b) => b.scope === "session_5h");
  assert.ok(bucket, "session_5h drift bucket present");
  assert.equal(bucket.n_estimate, 3, "n_estimate");
  assert.equal(bucket.n_measured, 3, "n_measured");
  assert.ok(bucket.estimate_avg_pct !== null && Math.abs(bucket.estimate_avg_pct - 60) < 0.01, "estimate_avg_pct ≈ 60");
  assert.ok(bucket.measured_avg_pct !== null && Math.abs(bucket.measured_avg_pct - 70) < 0.01, "measured_avg_pct ≈ 70");
  assert.ok(bucket.delta_pct !== null && Math.abs(bucket.delta_pct - 10) < 0.01, "delta_pct ≈ 10");
});

test("drift: estimate-only week_opus bucket has null delta_pct but populated estimate_avg_pct", () => {
  const now = Math.floor(Date.now() / 1000);
  const at = now - 100;

  insertUsageLimit({ source: "estimate", scope: "week_opus", model_bucket: "opus", used_pct: 50, observed_at: at });

  const result = computeGuardAccuracy(now);

  const bucket = result.drift.find((b) => b.scope === "week_opus");
  assert.ok(bucket, "week_opus drift bucket present");
  assert.equal(bucket.n_estimate, 1);
  assert.equal(bucket.n_measured, 0);
  assert.ok(bucket.estimate_avg_pct !== null, "estimate_avg_pct populated");
  assert.equal(bucket.measured_avg_pct, null, "measured_avg_pct null");
  assert.equal(bucket.delta_pct, null, "delta_pct null when one side missing");
});

test("drift: rows outside window are excluded", () => {
  const now = Math.floor(Date.now() / 1000);
  const outsideAt = now - 8 * 86400;

  insertUsageLimit({ source: "cli", scope: "session_5h", model_bucket: null, used_pct: 70, observed_at: outsideAt });

  const result = computeGuardAccuracy(now);

  assert.equal(result.drift.length, 0, "out-of-window row excluded from drift");
});

// -- Pause count / peak / guard misses --

test("pause_count, peak_pct, guard_miss_count from blockers in window", () => {
  const now = Math.floor(Date.now() / 1000);
  const recentAt = now - 3600;
  const oldAt = now - 8 * 86400;

  insertGuardBlocker({ kind: "usage_limit_soft", detail: { worst_pct: 78, source: "snapshot" }, created_at: recentAt });
  insertGuardBlocker({ kind: "usage_limit_soft", detail: { worst_pct: 79, source: "snapshot" }, created_at: recentAt });
  insertGuardBlocker({ kind: "usage_limit_hard", detail: { worst_pct: 82, source: "snapshot" }, created_at: recentAt });
  insertGuardBlocker({ kind: "usage_limit_hard", detail: { worst_pct: 100, source: "error" }, created_at: recentAt });
  // Out of 7d window — must be excluded
  insertGuardBlocker({ kind: "usage_limit_soft", detail: { worst_pct: 60, source: "snapshot" }, created_at: oldAt });

  const result = computeGuardAccuracy(now);

  assert.equal(result.pause_count, 4, "pause_count = 4 (old row excluded)");
  assert.equal(result.peak_pct, 100, "peak_pct = max worst_pct");
  assert.equal(result.guard_miss_count, 1, "guard_miss_count = source=error rows");
});

test("peak_pct is null when no blockers in window", () => {
  const now = Math.floor(Date.now() / 1000);
  const result = computeGuardAccuracy(now);
  assert.equal(result.pause_count, 0);
  assert.equal(result.peak_pct, null);
  assert.equal(result.guard_miss_count, 0);
});

// -- False pauses --

test("false_pause_count and false_pause_denom", () => {
  const now = Math.floor(Date.now() / 1000);
  // Blocker A and B use non-overlapping windows so B's measured row stays in B's range only.
  const blockerAAt = now - 7200; // 2h ago; window [now-7200, now-3600]
  const blockerBAt = now - 10800; // 3h ago; window [now-10800, now-7200]
  const twentyMinAgo = now - 1200;

  // Blocker A: 2h ago, no measured rows in its hour-window → false pause
  insertGuardBlocker({
    kind: "usage_limit_soft",
    detail: { worst_pct: 80, source: "snapshot" },
    created_at: blockerAAt,
  });

  // Blocker B: 3h ago, measured row at 85% 30min later → NOT a false pause
  insertGuardBlocker({
    kind: "usage_limit_soft",
    detail: { worst_pct: 78, source: "snapshot" },
    created_at: blockerBAt,
  });
  insertUsageLimit({
    source: "cli",
    scope: "session_5h",
    model_bucket: null,
    used_pct: 85,
    observed_at: blockerBAt + 1800, // 30min into B's window, 85 ≥ soft_pct(75)
  });

  // Blocker C: 20min ago — too young to judge (< 1h old), excluded from denom
  insertGuardBlocker({
    kind: "usage_limit_hard",
    detail: { worst_pct: 90, source: "snapshot" },
    created_at: twentyMinAgo,
  });

  const result = computeGuardAccuracy(now);

  assert.equal(result.false_pause_denom, 2, "denom = blockers ≥1h old (A and B)");
  assert.equal(result.false_pause_count, 1, "count = A only (B has measured evidence)");
});

test("false_pause_count=0 when all judgeable blockers have measured evidence above soft_pct", () => {
  const now = Math.floor(Date.now() / 1000);
  const twoHoursAgo = now - 7200;

  insertGuardBlocker({
    kind: "usage_limit_soft",
    detail: { worst_pct: 78, source: "snapshot" },
    created_at: twoHoursAgo,
  });
  insertUsageLimit({
    source: "cli",
    scope: "session_5h",
    model_bucket: null,
    used_pct: 85, // ≥ soft_pct (75)
    observed_at: twoHoursAgo + 600,
  });

  const result = computeGuardAccuracy(now);

  assert.equal(result.false_pause_denom, 1);
  assert.equal(result.false_pause_count, 0);
});

// -- Fleet-relevance filter --

test("drift: irrelevant model_bucket (not in fleet families) is excluded", () => {
  const now = Math.floor(Date.now() / 1000);
  const at = now - 100;

  // irrelevant-family is not in MODEL_BY_STAGE so isFleetRelevant returns false
  insertUsageLimit({ source: "estimate", scope: "week_irrelevant", model_bucket: "irrelevant-family", used_pct: 99, observed_at: at });
  // fleet-relevant baseline
  insertUsageLimit({ source: "estimate", scope: "session_5h", model_bucket: null, used_pct: 50, observed_at: at });

  const result = computeGuardAccuracy(now);

  const scopes = result.drift.map((b) => b.scope);
  assert.ok(!scopes.includes("week_irrelevant"), "irrelevant bucket excluded from drift");
  assert.ok(scopes.includes("session_5h"), "fleet-relevant bucket included");
});
