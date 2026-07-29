import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { cleanData, db, tables } from "../helpers/setup";
import { readUsageLimits, __setProviders } from "@/claude/limits";
import type { LimitProvider, LimitRow } from "@/claude/limits";
import { subscribe } from "@/lib/sse";

function nullProvider(name: "cli" | "oauth"): LimitProvider {
  return { name, probe: async () => null };
}

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
  // Reset CLI capability cache so each test starts from a clean probe state.
  delete (globalThis as Record<string, unknown>).__ai_auto_claude_cli_usage_capable;
});

// -- Acceptance 1: each source's fixture payload → normalized rows in usage_limits --

test("each source fixture writes normalized {scope, used_pct, resets_at, source} rows to usage_limits", async () => {
  const fixtures: Array<{ source: "cli" | "oauth"; rows: LimitRow[] }> = [
    {
      source: "cli",
      rows: [
        {
          scope: "session_5h",
          model_bucket: null,
          used_pct: 42,
          resets_at: 9_999_999,
          source: "cli",
          raw: '{"session":{"used":42,"limit":100}}',
        },
        {
          scope: "week_opus",
          model_bucket: "opus",
          used_pct: 30,
          resets_at: 9_999_999,
          source: "cli",
          raw: '{"session":{"used":42,"limit":100}}',
        },
      ],
    },
    {
      source: "oauth",
      rows: [
        {
          scope: "week",
          model_bucket: null,
          used_pct: 55.5,
          resets_at: null,
          source: "oauth",
          raw: '{"limits":[{"scope":"week","used_pct":55.5}]}',
        },
      ],
    },
  ];

  for (const { source, rows: fixture } of fixtures) {
    db.run(sql`DELETE FROM usage_limits`);

    const mock: LimitProvider = { name: source, probe: async () => fixture };
    __setProviders([mock]);

    const snap = await readUsageLimits();
    assert.equal(snap.length, fixture.length, `${source}: snapshot length`);

    const stored = db.select().from(tables.usageLimits).all();
    assert.equal(stored.length, fixture.length, `${source}: DB row count`);

    for (const r of stored) {
      assert.equal(r.source, source, `${source}: source column`);
      assert.ok(typeof r.used_pct === "number", `${source}: used_pct is number`);
      assert.ok(r.scope.length > 0, `${source}: scope not empty`);
    }

    // Verify specific field values from the first fixture row
    const first = stored.find((r) => r.scope === fixture[0].scope);
    assert.ok(first !== undefined, `${source}: first row present`);
    assert.equal(first.used_pct, fixture[0].used_pct);
    assert.equal(first.resets_at, fixture[0].resets_at);
    assert.equal(first.source, fixture[0].source);
  }
});

// -- Acceptance 2: throwing/absent provider falls through; no throw escapes readUsageLimits() --

test("throwing provider falls through to next provider", async () => {
  const throws: LimitProvider = {
    name: "cli",
    probe: async () => { throw new Error("cli exploded"); },
  };
  const works: LimitProvider = {
    name: "oauth",
    probe: async () => [
      { scope: "week", model_bucket: null, used_pct: 66, resets_at: null, source: "oauth", raw: null },
    ],
  };
  __setProviders([throws, works]);

  let snap: LimitRow[] | undefined;
  await assert.doesNotReject(async () => {
    snap = await readUsageLimits();
  });
  assert.ok(snap !== undefined);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].source, "oauth");

  const stored = db.select().from(tables.usageLimits).all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, "oauth");
});

test("null-returning provider falls through to next provider", async () => {
  __setProviders([
    nullProvider("cli"),
    {
      name: "oauth",
      probe: async () => [
        { scope: "session_5h", model_bucket: null, used_pct: 20, resets_at: null, source: "oauth", raw: null },
      ],
    },
  ]);

  const snap = await readUsageLimits();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].source, "oauth");
});

// -- Acceptance 3: real sources only — all unavailable → empty snapshot, nothing inserted --

test("all sources unavailable → empty snapshot, no rows inserted, no fabricated estimate", async () => {
  __setProviders([nullProvider("cli"), nullProvider("oauth")]);

  const snap = await readUsageLimits();
  assert.equal(snap.length, 0, "no fabricated rows when every real source fails");

  const stored = db.select().from(tables.usageLimits).all();
  assert.equal(stored.length, 0, "nothing inserted — view holds last real snapshot");
});

test("all sources throw → empty snapshot, no throw escapes", async () => {
  const boom = (name: "cli" | "oauth"): LimitProvider => ({
    name,
    probe: async () => { throw new Error(`${name} dead`); },
  });
  __setProviders([boom("cli"), boom("oauth")]);

  let snap: LimitRow[] | undefined;
  await assert.doesNotReject(async () => {
    snap = await readUsageLimits();
  });
  assert.ok(snap !== undefined);
  assert.equal(snap.length, 0);
});

// -- Acceptance 4: limits.changed fires exactly once per poll --

test("limits.changed fires exactly once per readUsageLimits() call", async () => {
  const mock: LimitProvider = {
    name: "cli",
    probe: async () => [
      { scope: "session_5h", model_bucket: null, used_pct: 25, resets_at: null, source: "cli", raw: null },
    ],
  };
  __setProviders([mock]);

  let fired = 0;
  const unsub = subscribe((ev) => {
    if (ev.type === "limits.changed") fired++;
  });

  await readUsageLimits();
  unsub();

  assert.equal(fired, 1, "limits.changed fires exactly once");
});

test("limits.changed not fired when no rows returned (all null)", async () => {
  __setProviders([nullProvider("cli"), nullProvider("oauth")]);

  let fired = 0;
  const unsub = subscribe((ev) => {
    if (ev.type === "limits.changed") fired++;
  });

  await readUsageLimits();
  unsub();

  assert.equal(fired, 0, "no event when no rows");
  const stored = db.select().from(tables.usageLimits).all();
  assert.equal(stored.length, 0, "no rows in DB");
});
