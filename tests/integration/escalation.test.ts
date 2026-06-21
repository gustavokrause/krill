import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  cleanData,
  createProject,
  createTask,
  db,
  tables,
} from "../helpers/setup";
import { task_escalate, task_resolve, task_verify } from "@/claude/mcp-tools";
import { setTodoPickerEnabled } from "@/workflow/blockers";
import { runEscalationResolver } from "@/workflow/escalation";
import { StubClaudeRunner } from "@/claude/stub-runner";
import { setRunner } from "@/claude";
import type { Stage } from "@/workflow/types";

let sandbox: string;

before(() => {
  setRunner(new StubClaudeRunner());
  cleanData();
});

beforeEach(() => {
  cleanData();
  setTodoPickerEnabled(true); // reset: prior defer/verify-brake pauses it
  sandbox = mkdtempSync(join(tmpdir(), "ai-escalation-"));
});

after(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

const row = (id: string) =>
  db.select().from(tables.tasks).where(eq(tables.tasks.id, id)).get()!;

const esc = (id: string) => JSON.parse(row(id).escalation ?? "null");

const pickerOn = (): boolean =>
  (db.select().from(tables.globalConfig).where(eq(tables.globalConfig.id, 1)).get()!
    .stage_enabled as { todo_picker: boolean }).todo_picker;

function ctx(taskId: string, stage: Stage) {
  return { token: "t", taskId, stage, expiresAt: Math.floor(Date.now() / 1000) + 60 };
}

function questionTask(opts: {
  origin?: string;
  resolver_tried?: boolean;
  workspace?: string;
}) {
  const p = createProject({ slug: "ES", has_repo: false, folder_path: opts.workspace ?? sandbox });
  return createTask(p, {
    name: "q",
    status: "NEEDS_REVIEW",
    pending_review_kind: "question",
    workspace_path: opts.workspace,
    escalation: JSON.stringify({
      question: "Which dependency direction?",
      options: ["producer first", "consumer first"],
      evidence: "both compile",
      origin_stage: opts.origin ?? "implementing",
      resolver_tried: opts.resolver_tried ?? false,
    }),
  });
}

test("task_escalate parks at NEEDS_REVIEW(question), records origin; does NOT pause yet", () => {
  const p = createProject({ slug: "ES" });
  const t = createTask(p, { name: "t1", status: "PLANNING" });

  const res = task_escalate(ctx(t.id, "planning"), "Which dep direction?", ["A", "B"], "ev") as {
    status: string;
    kind: string;
  };
  assert.equal(res.status, "NEEDS_REVIEW");
  assert.equal(res.kind, "question");
  const r = row(t.id);
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.equal(r.pending_review_kind, "question");
  assert.equal(esc(t.id).origin_stage, "planning");
  assert.equal(esc(t.id).resolver_tried, false);
  assert.equal(esc(t.id).options.length, 2);
  assert.equal(pickerOn(), true, "escalating doesn't pause — the resolver still has a shot");
});

test("task_escalate rejects an empty question", () => {
  const p = createProject({ slug: "ES" });
  const t = createTask(p, { name: "t1", status: "IMPLEMENTING" });
  assert.throws(() => task_escalate(ctx(t.id, "implementing"), "  ", [], ""), /requires a question/);
});

test("task_resolve decided → back to origin stage with the decision", () => {
  const t = questionTask({ origin: "implementing", resolver_tried: true });
  const res = task_resolve(ctx(t.id, "ai_review"), "decided", "consumer first", "matches existing pattern") as {
    status: string;
  };
  assert.equal(res.status, "IMPLEMENTING");
  assert.equal(row(t.id).status, "IMPLEMENTING");
  assert.equal(esc(t.id).decision, "consumer first");
  assert.equal(pickerOn(), true, "a resolved decision doesn't pause the line");
});

test("task_resolve defer → stays for human, sets needs_human, pauses the line", () => {
  const t = questionTask({ origin: "planning", resolver_tried: true });
  const res = task_resolve(ctx(t.id, "ai_review"), "defer", "", "needs a product priority call") as {
    status: string;
  };
  assert.equal(res.status, "NEEDS_REVIEW");
  assert.equal(row(t.id).pending_review_kind, "question");
  assert.equal(esc(t.id).needs_human, true);
  assert.equal(pickerOn(), false, "deferring to a human pauses the picker");
  const blockers = db
    .select()
    .from(tables.blockers)
    .where(eq(tables.blockers.task_id, t.id))
    .all();
  assert.ok(blockers.some((b) => b.kind === "escalation"), "a persistent escalation warning is filed");
});

test("task_resolve rejects outside NEEDS_REVIEW(question)", () => {
  const p = createProject({ slug: "ES" });
  const t = createTask(p, { name: "t1", status: "IMPLEMENTING" });
  assert.throws(() => task_resolve(ctx(t.id, "ai_review"), "defer", ""), /NEEDS_REVIEW\(question\)/);
});

test("runEscalationResolver: stub decides → task returns to origin; latches resolver_tried", async () => {
  const t = questionTask({ origin: "implementing", workspace: sandbox });

  const handled = await runEscalationResolver();
  assert.equal(handled, t.id);
  assert.equal(row(t.id).status, "IMPLEMENTING", "stub resolver decided and returned to origin");
  assert.equal(esc(t.id).resolver_tried, true);

  // Nothing left to auto-resolve.
  assert.equal(await runEscalationResolver(), null);
});

test("runEscalationResolver no-ops when escalation_auto_resolve is off", async () => {
  db.update(tables.globalConfig).set({ escalation_auto_resolve: false }).where(eq(tables.globalConfig.id, 1)).run();
  const t = questionTask({ origin: "implementing", workspace: sandbox });
  assert.equal(await runEscalationResolver(), null);
  assert.equal(row(t.id).status, "NEEDS_REVIEW", "untouched when auto-resolve disabled");
  assert.equal(esc(t.id).resolver_tried, false);
  db.update(tables.globalConfig).set({ escalation_auto_resolve: true }).where(eq(tables.globalConfig.id, 1)).run();
});

test("verify brake → NEEDS_REVIEW(verify) also pauses the line", () => {
  const p = createProject({ slug: "ES" });
  const t = createTask(p, { name: "t1", status: "VERIFYING", skip_verify: false });
  for (let i = 0; i < 3; i++) {
    task_verify(ctx(t.id, "verify"), "fail", `attempt ${i + 1}`);
    if (i < 2) {
      db.update(tables.tasks).set({ status: "VERIFYING" }).where(eq(tables.tasks.id, t.id)).run();
    }
  }
  assert.equal(row(t.id).pending_review_kind, "verify");
  assert.equal(pickerOn(), false, "a verify-brake landing pauses the picker");
});
