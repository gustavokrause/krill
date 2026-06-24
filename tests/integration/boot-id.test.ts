import { test } from "node:test";
import assert from "node:assert/strict";
import { getBootId } from "@/workflow/boot-id";

// The orphaned-claim signal: must be stable for the life of the process (so a
// dev recompile does NOT rotate it and falsely flag in-flight tasks "worker
// dead") and tied to the process identity (so a real restart rotates it).
test("getBootId is stable across calls and tied to the process pid", () => {
  const a = getBootId();
  const b = getBootId();
  assert.equal(a, b, "boot id must not change within a process");
  assert.equal(a, `pid-${process.pid}`, "boot id tracks the process pid");
});
