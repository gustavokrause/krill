import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
import { POST } from "@/app/api/tasks/[id]/resolve-conflict/route";
import { MANUAL_AI_COMMENT_PREFIX } from "@/lib/ai-comments";
import { now } from "@/workflow/types";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function call(id: string) {
  const res = await POST({} as never, ctx(id));
  const body = await res.json();
  return { status: res.status, body };
}

function makeConflictTask(opts: {
  worktreePath?: string | null;
  branch?: string | null;
  claimed_until?: number | null;
  claimed_by?: string | null;
}) {
  const sandbox = mkdtempSync(join(tmpdir(), "ai-resolve-"));
  const project = createProject({
    slug: "RC",
    has_repo: true,
    folder_path: sandbox,
  });
  const task = createTask(project, {
    name: "stuck conflict",
    status: "NEEDS_REVIEW",
    pending_review_kind: "conflict",
    mode: "dev",
    branch: opts.branch === undefined ? "rc-1-stuck-conflict" : opts.branch,
    worktree_path:
      opts.worktreePath === undefined
        ? join(sandbox, "missing-worktree")
        : opts.worktreePath,
    delivery_url: "https://example.com/pr/1",
    claimed_until: opts.claimed_until ?? null,
    claimed_by: opts.claimed_by ?? null,
  });
  return { project, task };
}

test("404 when task does not exist", async () => {
  const r = await call("does-not-exist");
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "not_found");
});

test("409 when task is not in NEEDS_REVIEW", async () => {
  const project = createProject({ slug: "WS", has_repo: true });
  const task = createTask(project, {
    name: "still publishing",
    status: "PUBLISHING",
    mode: "dev",
    branch: "ws-1",
    worktree_path: "/tmp/ws-wt",
  });
  const r = await call(task.id);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "invalid_state");
  assert.match(r.body.error.message, /not in NEEDS_REVIEW\(conflict\)/);
});

test("409 when NEEDS_REVIEW kind is deliverable, not conflict", async () => {
  const project = createProject({ slug: "DL", has_repo: false });
  const task = createTask(project, {
    name: "deliverable wait",
    status: "NEEDS_REVIEW",
    pending_review_kind: "deliverable",
  });
  const r = await call(task.id);
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /not in NEEDS_REVIEW\(conflict\)/);
});

test("409 when task is already claimed by another worker", async () => {
  const { task } = makeConflictTask({
    claimed_until: now() + 120,
    claimed_by: "other-worker",
  });
  const r = await call(task.id);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "invalid_state");
  assert.match(r.body.error.message, /currently claimed/);
});

test("409 when worktree/branch are missing on the task", async () => {
  const { task } = makeConflictTask({ worktreePath: null, branch: null });
  const r = await call(task.id);
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /missing worktree/);
  // Claim should be released so the task is re-clickable.
  const after = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;
  assert.equal(after.claimed_until, null);
  assert.equal(after.claimed_by, null);
});

test("202 when NEEDS_REVIEW(conflict) is claimable; background failure appends [manual] comment without brake increment", async () => {
  const { task } = makeConflictTask({});
  const before = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;

  const r = await call(task.id);
  assert.equal(r.status, 202);
  assert.equal(r.body.task.id, task.id);
  assert.ok(r.body.task.claimed_by?.startsWith("resolve-conflict-"));
  assert.ok((r.body.task.claimed_until ?? 0) > now());

  // Background runner fires against a bogus worktree path; it will throw,
  // catch in the outer try/catch, and append a [manual]-prefixed comment.
  // Poll briefly for the comment to land.
  let manualComment: { author: string; text: string } | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    manualComment = db
      .select()
      .from(tables.comments)
      .where(eq(tables.comments.task_id, task.id))
      .all()
      .find(
        (c) => c.author === "ai" && c.text.startsWith(MANUAL_AI_COMMENT_PREFIX),
      );
    if (manualComment) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.ok(
    manualComment,
    "expected background runner to append a [manual]-prefixed AI comment after worktree failure",
  );

  // No `ai_auto_actions` field on tasks; the brake counter is derived
  // client-side from comments via the `[manual]` prefix filter, so the
  // presence of the prefix IS the no-brake-increment guarantee.
  assert.match(manualComment.text, /^\[manual\] /);

  // Task should not have advanced past NEEDS_REVIEW(conflict) on failure.
  const after = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;
  assert.equal(after.status, "NEEDS_REVIEW");
  assert.equal(after.pending_review_kind, "conflict");
  assert.equal(before.status, after.status);
});
