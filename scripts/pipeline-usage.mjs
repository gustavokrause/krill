#!/usr/bin/env node
// pipeline-usage — which stages do DONE tasks actually traverse?
//
//   node scripts/pipeline-usage.mjs [path/to/tasks.db]
//
// Reports, overall and broken down by project and by priority (whale's risk
// proxy: high→P1, medium→P2, low→P3), how many tasks ran the full pipeline
// and how often each stage was skipped. Decision rule: a skip showing up in
// >80% of tasks marks that stage as a merge/cut candidate.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.argv[2] ?? path.join(root, "data", "tasks.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

const FLAGS = ["skip_plan", "skip_plan_review", "skip_ai_review", "skip_verify", "auto_publish"];

const rows = db
  .prepare(
    `SELECT t.priority, t.skip_plan, t.skip_plan_review, t.skip_ai_review,
            t.skip_verify, t.auto_publish, p.slug AS project
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'DONE'`,
  )
  .all();
db.close();

if (!rows.length) {
  console.log(`no DONE tasks in ${dbPath}`);
  process.exit(0);
}

// skip_plan implies the plan-review gate never happens — count it as an
// effective skip_plan_review too, or the review column undercounts.
const effective = (r) => ({
  ...r,
  skip_plan_review: r.skip_plan_review || r.skip_plan,
});

const fullPath = (r) => FLAGS.every((f) => !effective(r)[f]);

function summarize(list) {
  const n = list.length;
  const out = { tasks: n, "full path": count(list, fullPath) };
  for (const f of FLAGS) out[f] = count(list, (r) => effective(r)[f]);
  return out;
}
const count = (list, pred) => {
  const c = list.filter(pred).length;
  return c === 0 ? "0" : `${c} (${Math.round((c / list.length) * 100)}%)`;
};

function groupBy(list, key) {
  const m = new Map();
  for (const r of list) {
    const k = key(r) ?? "?";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function printTable(title, entries) {
  console.log(`\n═══ ${title} ═══`);
  const cols = ["", "tasks", "full path", ...FLAGS];
  const table = entries.map(([label, list]) => ({ "": label, ...summarize(list) }));
  const widths = cols.map((c) => Math.max(c.length, ...table.map((r) => String(r[c] ?? "").length)));
  const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(widths.map((w) => "─".repeat(w)).join("──"));
  for (const r of table) console.log(line(cols.map((c) => r[c])));
}

printTable("overall", [["all DONE", rows]]);
printTable("by project", groupBy(rows, (r) => r.project));
printTable("by priority (risk proxy: P1=high · P2=medium · P3=low)", groupBy(rows, (r) => r.priority));

const overall = summarize(rows);
const hot = FLAGS.filter((f) => {
  const m = String(overall[f]).match(/\((\d+)%\)/);
  return m && Number(m[1]) > 80;
});
if (hot.length) {
  console.log(`\n⚠ cut candidates (>80% skipped): ${hot.join(", ")}`);
}
