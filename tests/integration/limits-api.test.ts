import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { cleanData, db, tables } from "../helpers/setup";
import { GET } from "@/app/api/limits/route";
import { POST as postResume } from "@/app/api/limits/resume/route";
import { POST as postRefresh } from "@/app/api/limits/refresh/route";
import { GET as getHealth } from "@/app/api/health/route";
import { NextRequest } from "next/server";
import { __setProviders } from "@/claude/limits";
import type { LimitProvider } from "@/claude/limits";
import { subscribe } from "@/lib/sse";
import type { LimitsView } from "@/lib/limits-view";

const ALL_STAGES_ENABLED = {
  todo_picker: true,
  planning: true,
  implementing: true,
  ai_review: true,
  verify: true,
  publishing: true,
};

function seedUsageLimits(rows: Array<{
  scope: string;
  model_bucket: string | null;
  used_pct: number;
  resets_at: number | null;
  source: "cli" | "oauth" | "estimate";
}>) {
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    db.insert(tables.usageLimits).values({
      id: randomUUID(),
      source: r.source,
      scope: r.scope,
      model_bucket: r.model_bucket,
      used_pct: r.used_pct,
      resets_at: r.resets_at,
      observed_at: now,
      raw: null,
    }).run();
  }
}

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
  db.update(tables.globalConfig)
    .set({
      automation_enabled: true,
      stage_enabled: ALL_STAGES_ENABLED,
      paused_by_limit: false,
      limit_resume_at: null,
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();
});

// -- GET /api/limits shape --

test("GET /api/limits returns 200 with buckets, guard_state, source, stale fields", async () => {
  seedUsageLimits([
    { scope: "session_5h", model_bucket: null, used_pct: 42, resets_at: 9_999_999, source: "cli" },
    { scope: "week_opus", model_bucket: "opus", used_pct: 30, resets_at: 9_999_999, source: "cli" },
  ]);

  const res = await GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as LimitsView;

  assert.ok(Array.isArray(body.buckets), "buckets is array");
  assert.equal(body.buckets.length, 2);

  const first = body.buckets.find((b) => b.scope === "session_5h");
  assert.ok(first, "session_5h bucket present");
  assert.equal(first.used_pct, 42);
  assert.equal(first.resets_at, 9_999_999);
  assert.equal(first.source, "cli");

  assert.ok("guard_state" in body, "guard_state present");
  assert.equal(body.guard_state, "normal");
  assert.ok("worst_pct" in body, "worst_pct present");
  assert.ok("stale" in body, "stale present");
  assert.ok("observed_at" in body, "observed_at present");
  assert.equal(body.source, "cli");
});

test("GET /api/limits returns empty buckets when no usage_limits rows", async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as LimitsView;
  assert.deepEqual(body.buckets, []);
  assert.equal(body.worst_pct, null);
  assert.equal(body.stale, true);
  assert.equal(body.guard_state, "normal");
});

// -- GET /api/health includes limits block --

test("GET /api/health includes limits block with guard_state", async () => {
  seedUsageLimits([
    { scope: "session_5h", model_bucket: null, used_pct: 60, resets_at: null, source: "oauth" },
  ]);

  const res = await getHealth();
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;

  assert.ok("limits" in body, "health has limits block");
  const limits = body.limits as LimitsView;
  assert.ok("guard_state" in limits, "limits.guard_state present");
  assert.ok("buckets" in limits, "limits.buckets present");
  assert.equal(limits.guard_state, "normal");
  assert.equal(Array.isArray(limits.buckets), true);
  assert.ok((limits.buckets as unknown[]).length > 0, "at least one bucket");
});

// -- POST /api/limits/resume — guard-owned pause --

test("POST /api/limits/resume with guard-owned pause restores config and returns restored=true", async () => {
  // Simulate guard having paused (soft pause: todo_picker off, paused_by_limit=true)
  db.update(tables.globalConfig)
    .set({
      stage_enabled: { ...ALL_STAGES_ENABLED, todo_picker: false },
      paused_by_limit: true,
      limit_resume_at: Math.floor(Date.now() / 1000) + 3600,
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  const res = await postResume(new NextRequest("http://localhost/api/limits/resume", { method: "POST" }));
  assert.equal(res.status, 200);
  const body = await res.json() as { restored: boolean; view: LimitsView };

  assert.equal(body.restored, true);
  assert.ok("view" in body, "view returned");
  assert.equal(body.view.guard_state, "normal");
  assert.equal(body.view.paused_by_limit, false);

  // DB reflects the restore
  const cfg = db.select().from(tables.globalConfig).where(eq(tables.globalConfig.id, 1)).get()!;
  assert.equal(cfg.paused_by_limit, false);
  assert.equal(cfg.limit_resume_at, null);
});

// -- POST /api/limits/resume — human pause untouched --

test("POST /api/limits/resume with human pause (paused_by_limit=false) is a no-op", async () => {
  // Human set automation_enabled=false without paused_by_limit
  db.update(tables.globalConfig)
    .set({ automation_enabled: false, paused_by_limit: false })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  const res = await postResume(new NextRequest("http://localhost/api/limits/resume", { method: "POST" }));
  assert.equal(res.status, 200);
  const body = await res.json() as { restored: boolean; view: LimitsView };

  assert.equal(body.restored, false, "no-op when paused_by_limit=false");

  // Human pause unchanged
  const cfg = db.select().from(tables.globalConfig).where(eq(tables.globalConfig.id, 1)).get()!;
  assert.equal(cfg.automation_enabled, false, "human pause left untouched");
  assert.equal(cfg.paused_by_limit, false);
});

// -- POST /api/limits/refresh --

test("POST /api/limits/refresh triggers readUsageLimits and returns fresh view", async () => {
  const mock: LimitProvider = {
    name: "cli",
    probe: async () => [
      { scope: "session_5h", model_bucket: null, used_pct: 55, resets_at: null, source: "cli", raw: null },
    ],
  };
  __setProviders([mock]);

  const res = await postRefresh(new NextRequest("http://localhost/api/limits/refresh", { method: "POST" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as LimitsView;

  assert.ok(body.buckets.length > 0, "view has buckets after refresh");
  assert.equal(body.buckets[0].used_pct, 55);
  assert.equal(body.source, "cli");
});

// -- SSE: single limits.changed on guard state transition via handleLimitsSnapshot --

test("guard state transition fires exactly one limits.changed SSE event with updated guard_state", async () => {
  const { handleLimitsSnapshot } = await import("@/workflow/limit-guard");

  const events: LimitsView[] = [];
  const unsub = subscribe((ev) => {
    if (ev.type === "limits.changed") events.push(ev.view);
  });

  // normal → soft_paused (75% ≥ soft threshold default 75)
  handleLimitsSnapshot([
    { scope: "session_5h", model_bucket: null, used_pct: 75, resets_at: null, source: "cli" },
  ]);

  unsub();

  // Exactly one re-broadcast from the state change
  assert.equal(events.length, 1, "exactly one limits.changed from state transition");
  assert.equal(events[0].guard_state, "soft_paused");
  assert.equal(events[0].paused_by_limit, true);
});

test("guard state no-change (still normal at 74%) fires no limits.changed re-broadcast", () => {
  const { handleLimitsSnapshot } = require("@/workflow/limit-guard") as typeof import("@/workflow/limit-guard");

  const events: LimitsView[] = [];
  const unsub = subscribe((ev) => {
    if (ev.type === "limits.changed") events.push(ev.view);
  });

  handleLimitsSnapshot([
    { scope: "session_5h", model_bucket: null, used_pct: 74, resets_at: null, source: "cli" },
  ]);

  unsub();
  assert.equal(events.length, 0, "no re-broadcast when guard state unchanged");
});
