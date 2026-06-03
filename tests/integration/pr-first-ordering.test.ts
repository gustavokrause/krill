// Regression guard via source-text inspection, NOT a behavioral call-order
// spy. node:test's ESM module mocking still requires
// `--experimental-test-module-mocks` and our test runner does not set it, so
// this asserts the textual order of `await ensurePr(` vs `await mergeOriginInto(`
// in the publishRepo function body. Brittle to refactor, deterministic in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/workflow/stages/publishing.ts"),
  "utf8",
);

function extractFunctionBody(src: string, signaturePrefix: string): string {
  const start = src.indexOf(signaturePrefix);
  if (start < 0) {
    throw new Error(`function start not found: ${signaturePrefix}`);
  }
  const openBrace = src.indexOf("{", start);
  let depth = 1;
  let i = openBrace + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return src.slice(openBrace, i);
}

test("publishRepo opens PR before attempting merge (PR-first invariant)", () => {
  const body = extractFunctionBody(SRC, "async function publishRepo(");
  const prIdx = body.indexOf("await ensurePr(");
  const mergeIdx = body.indexOf("await mergeOriginInto(");
  assert.ok(prIdx > 0, "expected `await ensurePr(` in publishRepo body");
  assert.ok(mergeIdx > 0, "expected `await mergeOriginInto(` in publishRepo body");
  assert.ok(
    prIdx < mergeIdx,
    `PR-first invariant broken: ensurePr at ${prIdx}, mergeOriginInto at ${mergeIdx}`,
  );
});

test("publishRepo opens PR before resetWorktreeToOriginBranch (the merge prep step)", () => {
  const body = extractFunctionBody(SRC, "async function publishRepo(");
  const prIdx = body.indexOf("await ensurePr(");
  const resetIdx = body.indexOf("await resetWorktreeToOriginBranch(");
  assert.ok(resetIdx > 0, "expected reset call in publishRepo");
  assert.ok(
    prIdx < resetIdx,
    `PR must open before any merge-prep step; ensurePr=${prIdx}, reset=${resetIdx}`,
  );
});

test("publishRepo writes delivery_url from PR result before any merge call", () => {
  const body = extractFunctionBody(SRC, "async function publishRepo(");
  const deliveryWriteIdx = body.indexOf("delivery_url: pr.url");
  const mergeIdx = body.indexOf("await mergeOriginInto(");
  assert.ok(deliveryWriteIdx > 0, "expected delivery_url write from PR");
  assert.ok(
    deliveryWriteIdx < mergeIdx,
    `delivery_url must be persisted before merge attempt; write=${deliveryWriteIdx}, merge=${mergeIdx}`,
  );
});

test("attemptAiConflictResolve runs after the initial mergeOriginInto + appendAiComment", () => {
  const body = extractFunctionBody(SRC, "async function publishRepo(");
  const mergeIdx = body.indexOf("await mergeOriginInto(");
  const resolveIdx = body.indexOf("await attemptAiConflictResolve(");
  // attemptAiConflictResolve is the recovery branch — it must come after the
  // initial merge call that decides resolved vs conflict.
  assert.ok(resolveIdx > mergeIdx, "AI resolve must be after first merge attempt");
});
