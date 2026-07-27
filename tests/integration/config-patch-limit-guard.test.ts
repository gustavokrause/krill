import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { cleanData, db, tables } from "../helpers/setup";
import { PATCH } from "@/app/api/config/route";
import { NextRequest } from "next/server";
import type { GlobalConfig } from "@/db/schema";

function configPatch(body: Record<string, unknown>) {
  return PATCH(
    new NextRequest("http://localhost/api/config", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
  // Reset limit-guard columns to defaults so test order doesn't bleed state.
  db.update(tables.globalConfig)
    .set({
      limit_guard_enabled: true,
      limit_soft_pct: 75,
      limit_hard_pct: 80,
      limit_poll_sec: 120,
      limit_resume_grace_sec: 60,
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();
});

// -- Intra-payload soft > hard --

test("rejects {limit_soft_pct: 90, limit_hard_pct: 80} with 400 (both in payload)", async () => {
  const res = await configPatch({ limit_soft_pct: 90, limit_hard_pct: 80 });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, "validation_failed");
});

// -- Mixed-case: only soft patched, stored hard=80 makes merged soft > hard --

test("rejects PATCH {limit_soft_pct: 95} when stored hard=80 (merged soft > hard)", async () => {
  const res = await configPatch({ limit_soft_pct: 95 });
  assert.equal(res.status, 400);
});

// -- Range violations --

test("rejects {limit_soft_pct: 0} (below min 1) with 400", async () => {
  const res = await configPatch({ limit_soft_pct: 0 });
  assert.equal(res.status, 400);
});

test("rejects {limit_hard_pct: 101} (above max 100) with 400", async () => {
  const res = await configPatch({ limit_hard_pct: 101 });
  assert.equal(res.status, 400);
});

// -- Poll cadence floor --

test("rejects {limit_poll_sec: 5} (below 30s floor) with 400", async () => {
  const res = await configPatch({ limit_poll_sec: 5 });
  assert.equal(res.status, 400);
});

// -- Valid full patch --

test("accepts valid full patch and persists all limit-guard fields", async () => {
  const res = await configPatch({
    limit_guard_enabled: false,
    limit_soft_pct: 60,
    limit_hard_pct: 70,
    limit_poll_sec: 300,
    limit_resume_grace_sec: 120,
  });
  assert.equal(res.status, 200);

  const body = await res.json() as { config: GlobalConfig };
  assert.equal(body.config.limit_guard_enabled, false);
  assert.equal(body.config.limit_soft_pct, 60);
  assert.equal(body.config.limit_hard_pct, 70);
  assert.equal(body.config.limit_poll_sec, 300);
  assert.equal(body.config.limit_resume_grace_sec, 120);

  // DB row matches response
  const row = db
    .select()
    .from(tables.globalConfig)
    .where(eq(tables.globalConfig.id, 1))
    .get()!;
  assert.equal(row.limit_guard_enabled, false);
  assert.equal(row.limit_soft_pct, 60);
  assert.equal(row.limit_hard_pct, 70);
  assert.equal(row.limit_poll_sec, 300);
  assert.equal(row.limit_resume_grace_sec, 120);
});
