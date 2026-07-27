import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { cleanData, db, tables } from "../helpers/setup";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

test("global_config has correct limit-guard defaults", () => {
  const row = db
    .select()
    .from(tables.globalConfig)
    .where(eq(tables.globalConfig.id, 1))
    .get();

  assert.ok(row !== undefined, "global_config row 1 must exist after seed");
  assert.equal(row.limit_guard_enabled, true);
  assert.equal(row.limit_soft_pct, 75);
  assert.equal(row.limit_hard_pct, 80);
  assert.equal(row.limit_poll_sec, 120);
  assert.equal(row.limit_resume_grace_sec, 60);
  assert.equal(row.paused_by_limit, false);
  assert.equal(row.limit_resume_at, null);
});

test("usage_limits starts empty", () => {
  const rows = db.select().from(tables.usageLimits).all();
  assert.equal(rows.length, 0);
});

test("usage_limits round-trip per source", () => {
  const now = Math.floor(Date.now() / 1000);
  const sources = ["cli", "oauth", "estimate"] as const;

  for (const source of sources) {
    db.insert(tables.usageLimits)
      .values({
        id: randomUUID(),
        source,
        scope: "session_5h",
        model_bucket: null,
        used_pct: 42.5,
        resets_at: now + 3600,
        observed_at: now,
        raw: JSON.stringify({ test: true }),
      })
      .run();
  }

  const rows = db.select().from(tables.usageLimits).all();
  assert.equal(rows.length, 3);
  const readSources = new Set(rows.map((r) => r.source));
  for (const s of sources) assert.ok(readSources.has(s));
  assert.equal(rows[0].used_pct, 42.5);
  assert.equal(rows[0].scope, "session_5h");
  assert.equal(rows[0].model_bucket, null);
});

test("usage_limits CHECK rejects invalid source", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.throws(
    () => {
      db.insert(tables.usageLimits)
        .values({
          id: randomUUID(),
          source: "invalid" as "cli",
          scope: "session_5h",
          used_pct: 50,
          observed_at: now,
        })
        .run();
    },
    /CHECK constraint failed/i,
  );
});
