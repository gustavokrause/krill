import { test } from "node:test";
import assert from "node:assert/strict";
import { isDocsOnlyDiff } from "@/workflow/stages/implementing";

// Guards the docs-only → skip-verify boundary. A false positive here ships a
// CODE change without the dynamic verify stage, so the negative cases matter
// most: anything runnable must NOT be classified docs-only.
test("isDocsOnlyDiff: pure docs diffs are docs-only", () => {
  assert.equal(isDocsOnlyDiff(["README.md"]), true);
  assert.equal(isDocsOnlyDiff(["docs/setup.md", "docs/api.mdx"]), true);
  assert.equal(isDocsOnlyDiff(["CHANGELOG.txt", "documentation/guide.rst"]), true);
  assert.equal(isDocsOnlyDiff(["docs/notes.adoc"]), true);
});

test("isDocsOnlyDiff: any runnable file makes it NOT docs-only", () => {
  assert.equal(isDocsOnlyDiff(["src/index.ts"]), false);
  assert.equal(isDocsOnlyDiff(["package.json"]), false);
  assert.equal(isDocsOnlyDiff(["migrations/0001_init.sql"]), false);
  // mixed: one doc + one code → still must verify
  assert.equal(isDocsOnlyDiff(["README.md", "src/index.ts"]), false);
  assert.equal(isDocsOnlyDiff(["docs/guide.md", "config.yaml"]), false);
});

test("isDocsOnlyDiff: empty diff is never docs-only", () => {
  assert.equal(isDocsOnlyDiff([]), false);
});
