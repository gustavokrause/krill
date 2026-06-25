import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { GET, POST } from "@/app/api/tasks/cleanup/route";
import { NextRequest } from "next/server";

const BASE_URL = "http://localhost/api/tasks/cleanup";

function getReq(window: string) {
  return new NextRequest(`${BASE_URL}?window=${window}`);
}

function postReq(body: unknown) {
  return new NextRequest(BASE_URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

test("GET returns count of in-window DONE/CANCELED tasks without deleting", async () => {
  const project = createProject({ slug: "CL" });
  const nowSec = Math.floor(Date.now() / 1000);
  const sixtyDaysAgo = nowSec - 60 * 24 * 60 * 60;

  // In window (ended today)
  createTask(project, { name: "done-in", status: "DONE", ended_at: nowSec });
  // Out of window (ended 60 days ago — outside "week")
  createTask(project, {
    name: "canceled-out",
    status: "CANCELED",
    ended_at: sixtyDaysAgo,
  });
  // Non-terminal (no ended_at)
  createTask(project, { name: "implementing", status: "IMPLEMENTING" });

  const res = await GET(getReq("week"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.window, "week");

  // Nothing deleted
  const remaining = db.select().from(tables.tasks).all();
  assert.equal(remaining.length, 3);
});

test("POST deletes only in-window terminal tasks", async () => {
  const project = createProject({ slug: "CL" });
  const nowSec = Math.floor(Date.now() / 1000);
  const sixtyDaysAgo = nowSec - 60 * 24 * 60 * 60;

  const inWindow = createTask(project, {
    name: "done-in",
    status: "DONE",
    ended_at: nowSec,
  });
  const outOfWindow = createTask(project, {
    name: "canceled-out",
    status: "CANCELED",
    ended_at: sixtyDaysAgo,
  });
  const nonTerminal = createTask(project, {
    name: "implementing",
    status: "IMPLEMENTING",
  });

  const res = await POST(postReq({ window: "week" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, 1);
  assert.equal(body.window, "week");

  // In-window task deleted
  const gone = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, inWindow.id))
    .get();
  assert.equal(gone, undefined);

  // Out-of-window terminal preserved
  const kept = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, outOfWindow.id))
    .get();
  assert.ok(kept, "out-of-window terminal should be preserved");

  // Non-terminal preserved
  const active = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, nonTerminal.id))
    .get();
  assert.ok(active, "non-terminal task should be preserved");
});

test("GET ?window=all counts all terminal tasks regardless of ended_at", async () => {
  const project = createProject({ slug: "CL" });
  const nowSec = Math.floor(Date.now() / 1000);
  const sixtyDaysAgo = nowSec - 60 * 24 * 60 * 60;

  createTask(project, { name: "done-recent", status: "DONE", ended_at: nowSec });
  createTask(project, {
    name: "canceled-old",
    status: "CANCELED",
    ended_at: sixtyDaysAgo,
  });
  createTask(project, { name: "implementing", status: "IMPLEMENTING" });

  const res = await GET(getReq("all"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 2);
});

test("POST with window=all after deleting in-window task counts the remaining", async () => {
  const project = createProject({ slug: "CL" });
  const nowSec = Math.floor(Date.now() / 1000);
  const sixtyDaysAgo = nowSec - 60 * 24 * 60 * 60;

  createTask(project, { name: "done-in", status: "DONE", ended_at: nowSec });
  createTask(project, {
    name: "canceled-old",
    status: "CANCELED",
    ended_at: sixtyDaysAgo,
  });

  // Delete in-window only
  await POST(postReq({ window: "week" }));

  // After POST, "all" should count the remaining old terminal
  const res = await GET(getReq("all"));
  const body = await res.json();
  assert.equal(body.count, 1);
});

test("POST returns 0 when no matching tasks", async () => {
  const project = createProject({ slug: "CL" });
  createTask(project, { name: "implementing", status: "IMPLEMENTING" });

  const res = await POST(postReq({ window: "week" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, 0);
});

test("GET with bad window returns 400", async () => {
  const res = await GET(getReq("invalid"));
  assert.equal(res.status, 400);
});

test("POST with bad window returns 400", async () => {
  const res = await POST(postReq({ window: "invalid" }));
  assert.equal(res.status, 400);
});
