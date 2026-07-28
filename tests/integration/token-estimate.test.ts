import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { estimateTaskTokens, stagesForTask, PRICE_WEIGHTS } from "@/lib/token-estimate";
import { POST } from "@/app/api/tasks/route";

beforeEach(() => cleanData());

function seedRows(
  taskId: string,
  projectId: string,
  stage: string,
  count: number,
  tokens: { input?: number; output?: number; cache_creation?: number; cache_read?: number },
) {
  const ts = Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i++) {
    db.insert(tables.stageUsage).values({
      id: randomUUID(),
      task_id: taskId,
      project_id: projectId,
      stage,
      model: "claude-sonnet-4-6",
      input_tokens: tokens.input ?? 0,
      output_tokens: tokens.output ?? 0,
      cache_creation_tokens: tokens.cache_creation ?? 0,
      cache_read_tokens: tokens.cache_read ?? 0,
      cost_usd: 0,
      num_turns: 1,
      duration_ms: 1000,
      resumed: 0,
      created_at: ts,
    }).run();
  }
}

function postTask(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

// --- stagesForTask ---

test("stagesForTask: dev mode, no skips → all four stages", () => {
  const stages = stagesForTask({ skip_plan: false, skip_ai_review: false, mode: "dev" });
  assert.deepEqual(stages.toSorted(), ["ai_review", "implementing", "planning", "verify"]);
});

test("stagesForTask: skip_plan drops planning, implementing stays", () => {
  const stages = stagesForTask({ skip_plan: true, skip_ai_review: false, mode: "dev" });
  assert.ok(!stages.includes("planning"));
  assert.ok(stages.includes("implementing"));
});

test("stagesForTask: non-dev mode defaults skip_verify → no verify", () => {
  const stages = stagesForTask({ skip_plan: false, skip_ai_review: false, mode: "non-dev" });
  assert.ok(!stages.includes("verify"));
});

test("stagesForTask: explicit skip_verify overrides mode", () => {
  const stages = stagesForTask({ skip_plan: true, skip_ai_review: true, skip_verify: false, mode: "non-dev" });
  assert.ok(stages.includes("verify"));
});

// --- estimateTaskTokens ---

test("estimateTaskTokens: null when no data at all", () => {
  const p = createProject({ slug: "T0" });
  const stages = stagesForTask({ skip_plan: false, skip_ai_review: false, mode: "dev" });
  assert.equal(estimateTaskTokens({ projectId: p.id, stages }), null);
});

test("estimateTaskTokens: project median used when >= MIN_PROJECT_SAMPLES rows", () => {
  const p = createProject({ slug: "T1" });
  const task = createTask(p, { name: "hist", status: "DONE", mode: "dev" });
  // input=1000, output=200 → weighted = 1000*1 + 200*5 = 2000
  seedRows(task.id, p.id, "implementing", 10, { input: 1000, output: 200 });

  const est = estimateTaskTokens({
    projectId: p.id,
    stages: ["implementing"],
  });
  assert.equal(est, 2000);
});

test("estimateTaskTokens: falls back to fleet when project below MIN_PROJECT_SAMPLES", () => {
  // P1 has 10 rows: weighted=2000 each
  const p1 = createProject({ slug: "T2" });
  const t1 = createTask(p1, { name: "hist", status: "DONE", mode: "dev" });
  seedRows(t1.id, p1.id, "implementing", 10, { input: 1000, output: 200 });

  // P2 has 2 rows: weighted=1000 each (below MIN=5 → should use fleet)
  const p2 = createProject({ slug: "T3" });
  const t2 = createTask(p2, { name: "hist", status: "DONE", mode: "dev" });
  seedRows(t2.id, p2.id, "implementing", 2, { input: 500, output: 100 });

  const est = estimateTaskTokens({ projectId: p2.id, stages: ["implementing"] });

  // Fleet = 12 rows: 10 at 2000, 2 at 1000. Sorted median of [1000,1000,2000×10] = 2000.
  // P2-only median would be 1000 (2 rows). Since P2 < MIN, fleet (2000) is used.
  assert.equal(est, 2000);
});

test("estimateTaskTokens: cache_read weighted at 0.1x, not 1x", () => {
  const p = createProject({ slug: "T4" });
  const task = createTask(p, { name: "hist", status: "DONE", mode: "dev" });
  // input=1000, cache_read=100_000_000 → weighted = 1000*1 + 100_000_000*0.1 = 10_001_000
  seedRows(task.id, p.id, "implementing", 10, { input: 1000, cache_read: 100_000_000 });

  const est = estimateTaskTokens({ projectId: p.id, stages: ["implementing"] });
  assert.equal(est, 10_001_000);
  // Without price weighting the raw sum would be ~100_001_000 (10× larger)
  assert.ok(est! < 100_000_000, "cache_read did not inflate the estimate");
});

test("estimateTaskTokens: sums medians across multiple stages", () => {
  const p = createProject({ slug: "T5" });
  const task = createTask(p, { name: "hist", status: "DONE", mode: "dev" });
  // implementing: weighted=2000 per row
  seedRows(task.id, p.id, "implementing", 10, { input: 1000, output: 200 });
  // planning: weighted=3500 per row (input=1000, output=500 → 1000+2500=3500)
  seedRows(task.id, p.id, "planning", 10, { input: 1000, output: 500 });

  const est = estimateTaskTokens({ projectId: p.id, stages: ["implementing", "planning"] });
  assert.equal(est, 2000 + 3500);
});

// Validate the PRICE_WEIGHTS constant matches what the SQL computes
test("PRICE_WEIGHTS constants: cache_read is 0.1", () => {
  assert.equal(PRICE_WEIGHTS.cache_read, 0.1);
  assert.equal(PRICE_WEIGHTS.output, 5);
  assert.equal(PRICE_WEIGHTS.cache_creation, 1.25);
});

// --- POST /api/tasks ---

test("POST /api/tasks: different skip flags → different est_tokens", async () => {
  const p = createProject({ slug: "T6", has_repo: true });
  const task = createTask(p, { name: "hist", status: "DONE", mode: "dev" });
  seedRows(task.id, p.id, "implementing", 10, { input: 1000, output: 200 });
  seedRows(task.id, p.id, "planning", 10, { input: 2000, output: 300 });

  const base = {
    project_id: p.id,
    mode: "dev",
    skip_ai_review: true,
    skip_verify: true,
  };

  const resA = await postTask({ ...base, name: "A", skip_plan: false });
  const resB = await postTask({ ...base, name: "B", skip_plan: true });

  const { task: tA } = await resA.json();
  const { task: tB } = await resB.json();

  // A runs planning+implementing, B runs implementing only → A > B
  assert.ok(tA.est_tokens > tB.est_tokens, "more stages → higher estimate");
});

test("POST /api/tasks: body est_tokens is ignored; stored value = estimateTaskTokens output", async () => {
  const p = createProject({ slug: "T7", has_repo: true });
  const task = createTask(p, { name: "hist", status: "DONE", mode: "dev" });
  // input=1000, output=200 → weighted = 2000
  seedRows(task.id, p.id, "implementing", 10, { input: 1000, output: 200 });

  const res = await postTask({
    project_id: p.id,
    name: "body est ignored",
    mode: "dev",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
    est_tokens: 999_999_999,
  });

  const { task: created } = await res.json();
  assert.notEqual(created.est_tokens, 999_999_999, "body-supplied value must be discarded");
  assert.equal(created.est_tokens, 2000, "stored value equals estimateTaskTokens output");
});

test("POST /api/tasks: no stage_usage → est_tokens is null", async () => {
  const p = createProject({ slug: "T8", has_repo: true });

  const res = await postTask({
    project_id: p.id,
    name: "no history",
    mode: "dev",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
  });

  const { task: created } = await res.json();
  assert.equal(created.est_tokens, null);
});
