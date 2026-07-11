import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { posix as posixPath, relative } from "node:path";
import { db } from "@/db/client";
import {
  CONFLICTS_BLOCKING_STATUSES,
  comments,
  followups,
  projects,
  tasks,
  type Comment,
  type Project,
  type Task,
} from "@/db/schema";
import { resolveProjectPath } from "@/lib/api/util";
import { broadcast } from "@/lib/sse";
import { appendAiComment } from "@/workflow/comment";
import { addBlocker, pauseLineForHuman, setTodoPickerEnabled } from "@/workflow/blockers";
import { transitionStatus } from "@/workflow/transition";
import { countAiAutoActions, getMaxAiDeclineCycles } from "@/workflow/loop-brake";
import { now, type Stage } from "@/workflow/types";
import { McpAuthError } from "./errors";
import type { McpAuthContext } from "./mcp-auth";

/**
 * Event-driven chaining: kick the next stage's tick immediately after a
 * verdict-driven transition instead of waiting out the cron slot. Keeps
 * same-model hops (impl→verify, decline→re-implement) inside the prompt-cache
 * TTL so session resumes hit warm cache. Fire-and-forget — the tick carries
 * all its own guards (claims, stage_enabled, backoff); a failure here just
 * means the cron picks it up on schedule as before. Dynamic import dodges the
 * mcp-tools ↔ tick import cycle.
 */
function kickStage(stage: "implementing" | "verify" | "publishing"): void {
  void import("@/workflow/tick")
    .then((m) => m.tick(stage))
    .catch(() => {});
}

const STAGE_GATES: Record<string, Stage[]> = {
  task_set_plan: ["planning"],
  task_set_plan_summary: ["planning"],
  task_set_acceptance: ["planning"],
  task_set_checklist: ["planning", "implementing"],
  task_set_affected_paths: ["planning", "implementing"],
  task_append_comment: [
    "todo_picker",
    "planning",
    "implementing",
    "ai_review",
    "verify",
    "publishing",
  ],
  task_decide: ["ai_review"],
  task_verify: ["verify"],
  // Escalate is open to every stage that runs a Claude pass; the resolver issues
  // its token under the ai_review (Opus) context, so task_resolve is allowed
  // there (it additionally guards on the task being NEEDS_REVIEW(question)).
  task_escalate: ["planning", "implementing", "ai_review", "verify"],
  task_resolve: ["planning", "implementing", "ai_review", "verify"],
  task_seed_followup: ["planning", "implementing", "ai_review", "verify", "publishing"],
  task_context: [
    "todo_picker",
    "planning",
    "implementing",
    "ai_review",
    "verify",
    "publishing",
  ],
};

function authorize(ctx: McpAuthContext, tool: keyof typeof STAGE_GATES): void {
  const allowed = STAGE_GATES[tool];
  if (!allowed.includes(ctx.stage)) {
    throw new McpAuthError(`tool ${tool} not allowed in stage ${ctx.stage}`);
  }
}

function loadTask(taskId: string): Task {
  const t = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!t) throw new McpAuthError(`task ${taskId} not found`);
  return t;
}

function loadProject(projectId: string): Project {
  const p = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!p) throw new McpAuthError(`project ${projectId} not found`);
  return p;
}

function loadComments(taskId: string): Comment[] {
  return db
    .select()
    .from(comments)
    .where(eq(comments.task_id, taskId))
    .orderBy(asc(comments.at))
    .all();
}

function loadPeersAffectedPaths(task: Task): Array<{
  task_id: string;
  affected_paths: string[];
}> {
  const peers = db
    .select({ id: tasks.id, affected_paths: tasks.affected_paths })
    .from(tasks)
    .where(
      and(
        eq(tasks.project_id, task.project_id),
        ne(tasks.id, task.id),
        inArray(tasks.status, CONFLICTS_BLOCKING_STATUSES),
      ),
    )
    .all();
  return peers.map((p) => ({
    task_id: p.id,
    affected_paths: p.affected_paths,
  }));
}

function normalizeAffectedPath(
  rawPath: string,
  projectFolder: string,
): string {
  const folder = resolveProjectPath(projectFolder);
  let p = rawPath;
  if (p.startsWith(folder)) p = relative(folder, p);
  p = posixPath.normalize(p.replaceAll("\\", "/"));
  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/")) p = p.slice(1);
  return p;
}

// -- Tools --

export function task_context(ctx: McpAuthContext) {
  authorize(ctx, "task_context");
  const task = loadTask(ctx.taskId);
  const project = loadProject(task.project_id);
  return {
    task: {
      id: task.id,
      name: task.name,
      description: task.description,
      status: task.status,
      mode: task.mode,
      priority: task.priority,
      plan: task.plan,
      checklist: task.checklist,
      affected_paths: task.affected_paths,
      depends_on: task.depends_on,
      conflicts_with: task.conflicts_with,
      branch: task.branch,
      worktree_path: task.worktree_path,
      workspace_path: task.workspace_path,
      skip_plan: task.skip_plan,
      skip_plan_review: task.skip_plan_review,
      skip_ai_review: task.skip_ai_review,
      skip_verify: task.skip_verify,
      acceptance: task.acceptance,
      // Why this task matters (plan-time hypothesis) — context for review and
      // verify; verify may capture before/after numbers when it names a
      // measurable quantity.
      expected_impact: task.expected_impact,
      escalation: task.escalation ? JSON.parse(task.escalation) : null,
      // Unified diff vs base, captured at IMPLEMENTING end. Review/verify use
      // this instead of re-running git diff; null before implementation or on
      // capture failure (then fall back to git in the worktree).
      diff: task.diff_text,
    },
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      folder_path: project.folder_path,
      has_repo: project.has_repo,
      default_branch: project.default_branch,
    },
    comments: loadComments(task.id),
    peers_affected_paths: loadPeersAffectedPaths(task),
  };
}

function emitTaskUpdated(taskId: string): void {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (task) broadcast({ type: "task.updated", task });
}

// A planning model occasionally malforms its task_set_plan_bundle call —
// closing a parameter with a field-named tag (`</plan>`) instead of
// `</parameter>`, so the CLI parser swallows the sibling parameters into the
// first field as raw tool-call XML. That markup then renders as garbage in the
// PR body (prBody) and the plan/checklist UI. Cut the value at the first leaked
// scaffold marker — a field-named close, a `<parameter name=`, or a
// `<function_calls>`/`<invoke>` wrapper — none of which belong in a stored
// plan/summary/checklist. Deliberately conservative: only these exact tool-call
// markers, never arbitrary `<...>` (legit dev-mode plans contain code/JSX).
const SCAFFOLD_LEAK_RE =
  /<\/(?:plan|plan_summary|checklist|acceptance)>|<parameter\s+name=|<\/parameter>|<\/?function_calls>|<\/?invoke\b/i;

export function stripToolScaffold(value: string): string {
  const m = value.match(SCAFFOLD_LEAK_RE);
  return (m ? value.slice(0, m.index) : value).trimEnd();
}

export function task_set_plan(ctx: McpAuthContext, plan: string) {
  authorize(ctx, "task_set_plan");
  db.update(tasks)
    .set({ plan: stripToolScaffold(plan), updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true };
}

/**
 * Set the task's acceptance (definition-of-done VERIFYING checks against).
 * PLANNING calls this only when acceptance is still empty — a value set upstream
 * at task creation or by a human is left untouched (the prompt enforces the
 * "only if absent" rule; this tool just writes what it's given).
 */
export function task_set_plan_summary(ctx: McpAuthContext, plan_summary: string) {
  authorize(ctx, "task_set_plan_summary");
  db.update(tasks)
    .set({ plan_summary: stripToolScaffold(plan_summary), updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true };
}

export function task_set_acceptance(ctx: McpAuthContext, acceptance: string) {
  authorize(ctx, "task_set_acceptance");
  db.update(tasks)
    .set({ acceptance: stripToolScaffold(acceptance), updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true };
}

export function task_set_checklist(ctx: McpAuthContext, checklist: string) {
  authorize(ctx, "task_set_checklist");
  db.update(tasks)
    .set({ checklist: stripToolScaffold(checklist), updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true };
}

export function task_set_affected_paths(
  ctx: McpAuthContext,
  paths: string[],
) {
  authorize(ctx, "task_set_affected_paths");
  const task = loadTask(ctx.taskId);
  const project = loadProject(task.project_id);
  const normalized = paths.map((p) => normalizeAffectedPath(p, project.folder_path));
  db.update(tasks)
    .set({ affected_paths: normalized, updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true, affected_paths: normalized };
}

/**
 * Batch the PLANNING writes into ONE call. Each separate MCP tool call is a full
 * agentic turn = a context re-read, so planning paid ~5 turns just to persist its
 * structured output. This collapses them. Delegates to the individual setters
 * (each runs its own PLANNING authorize), so semantics are identical. acceptance
 * is optional and written only when provided — the "don't overwrite an existing
 * acceptance" rule stays prompt-enforced, same as the standalone tool.
 */
export function task_set_plan_bundle(
  ctx: McpAuthContext,
  args: {
    plan: string;
    plan_summary: string;
    checklist: string;
    affected_paths: string[];
    acceptance?: string;
  },
) {
  task_set_plan(ctx, args.plan);
  task_set_plan_summary(ctx, args.plan_summary);
  task_set_checklist(ctx, args.checklist);
  const ap = task_set_affected_paths(ctx, args.affected_paths);
  if (typeof args.acceptance === "string" && args.acceptance.trim()) {
    task_set_acceptance(ctx, args.acceptance);
  }
  return { ok: true, affected_paths: ap.affected_paths };
}

export function task_append_comment(
  ctx: McpAuthContext,
  stage: Task["status"],
  text: string,
) {
  authorize(ctx, "task_append_comment");
  const id = randomUUID();
  const inserted = db
    .insert(comments)
    .values({
      id,
      task_id: ctx.taskId,
      at: now(),
      stage,
      author: "ai",
      text,
    })
    .returning()
    .all();
  db.update(tasks)
    .set({ updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  if (inserted[0]) broadcast({ type: "comment.appended", comment: inserted[0] });
  emitTaskUpdated(ctx.taskId);
  return { ok: true, id };
}

/**
 * Flag out-of-scope follow-up work the stage noticed but did NOT do. Records a
 * follow-up for whale to pull into its inbox (krill→whale feedback) — it does
 * NOT create a krill task. Keeps the current task tightly scoped.
 */
export function task_seed_followup(
  ctx: McpAuthContext,
  title: string,
  description = "",
) {
  authorize(ctx, "task_seed_followup");
  const task = loadTask(ctx.taskId);
  const id = randomUUID();
  const cleanTitle = title.trim();
  const cleanDesc = (description ?? "").trim();
  db.insert(followups)
    .values({
      id,
      task_id: ctx.taskId,
      project_id: task.project_id,
      title: cleanTitle,
      description: cleanDesc,
      status: "open",
      created_at: now(),
    })
    .run();

  // Trace it on the origin task, then pause auto-picking behind a persistent
  // warning so a human reviews the surfaced work before krill picks more. The
  // blocker carries the content (not derived from the followups row), so it
  // survives the downstream consumer marking the follow-up consumed.
  appendAiComment(ctx.taskId, `Seeded follow-up: ${cleanTitle}`, task.status);
  addBlocker({
    kind: "followup",
    task_id: ctx.taskId,
    stage: ctx.stage,
    summary: `Follow-up surfaced by ${ctx.taskId} (${ctx.stage})`,
    detail: cleanDesc ? `${cleanTitle}\n\n${cleanDesc}` : cleanTitle,
    dedupe: false,
  });
  setTodoPickerEnabled(false);

  return { ok: true, id };
}

export type DecisionOutcome = "approve" | "decline";

// What a cleared AI-REVIEW advances to: VERIFYING by default, or straight to
// PUBLISHING when the task opted out of verification.
function postAiReviewTarget(task: Task): "VERIFYING" | "PUBLISHING" {
  return task.skip_verify ? "PUBLISHING" : "VERIFYING";
}

export function task_decide(
  ctx: McpAuthContext,
  outcome: DecisionOutcome,
  reason: string,
  staticSufficient = false,
) {
  authorize(ctx, "task_decide");
  const task = loadTask(ctx.taskId);

  if (task.status !== "AI-REVIEW") {
    throw new McpAuthError(
      `task_decide requires status AI-REVIEW, got ${task.status}`,
    );
  }

  if (outcome === "approve") {
    // Static-sufficient approve (tracker B3): the reviewer judged the diff
    // static/low-blast-radius — a dynamic VERIFYING spawn would only re-read
    // what this review just cleared. Only flips a still-default skip_verify;
    // an explicit human choice is never overridden.
    if (staticSufficient && !task.skip_verify) {
      db.update(tasks)
        .set({ skip_verify: true, updated_at: now() })
        .where(eq(tasks.id, ctx.taskId))
        .run();
      task.skip_verify = true;
      task_append_comment(
        ctx,
        "AI-REVIEW",
        "static-sufficient: review fully covers this diff — skipping dynamic verify.",
      );
    }
    const target = postAiReviewTarget(task);
    task_append_comment(ctx, "AI-REVIEW", `approve: ${reason}`);
    const moved = transitionStatus({
      taskId: ctx.taskId,
      from: "AI-REVIEW",
      to: target,
    });
    if (!moved) throw new McpAuthError("transition lost; retry");
    kickStage(target === "VERIFYING" ? "verify" : "publishing");
    return { ok: true, status: target };
  }

  // decline path — append reason and check brake
  task_append_comment(ctx, "AI-REVIEW", `decline: ${reason}`);

  const max = getMaxAiDeclineCycles();
  const count = countAiAutoActions(ctx.taskId, "AI-REVIEW");
  if (count >= max) {
    // Park for a human — do NOT force the task forward. After `max` declines the
    // change still doesn't pass review; advancing it toward PUBLISHING would ship
    // the rejected work (and AUTO-MERGE it on an armed task). Mirror the VERIFYING
    // brake: stop at NEEDS_REVIEW(declined) so a person decides.
    task_append_comment(
      ctx,
      "AI-REVIEW",
      `max AI decline cycles (${max}) reached — parking for human review; the change has not passed review after ${max} attempts.`,
    );
    const parked = transitionStatus({
      taskId: ctx.taskId,
      from: "AI-REVIEW",
      to: "NEEDS_REVIEW",
      pendingReviewKind: "declined",
    });
    if (!parked) throw new McpAuthError("brake transition lost; retry");
    return { ok: true, status: "NEEDS_REVIEW", parked: true };
  }

  const moved = transitionStatus({
    taskId: ctx.taskId,
    from: "AI-REVIEW",
    to: "IMPLEMENTING",
  });
  if (!moved) throw new McpAuthError("decline transition lost; retry");
  kickStage("implementing");
  return { ok: true, status: "IMPLEMENTING" };
}

export type VerifyOutcome = "pass" | "fail";

export type VerifyMeasurement = {
  metric: string;
  before?: string;
  after: string;
  source: string;
};

/**
 * VERIFYING decision. pass → PUBLISHING. fail → IMPLEMENTING (re-run with the
 * failure as the next instruction). Reuses the AI decline brake: after
 * max_ai_decline_cycles fails the run can't self-correct, so it parks at
 * NEEDS_REVIEW(verify) for a human instead of looping.
 *
 * `measurements` (optional): quantified before/after evidence actually
 * OBSERVED in the worktree (build output, test timing, a measured request)
 * when the acceptance/expected_impact names a measurable. Stored on the task
 * as the value ledger's measured side. Deliberately NOT a gate — pass/fail is
 * keyed on acceptance only, so hypotheses stay honest instead of sandbagged.
 */
export function task_verify(
  ctx: McpAuthContext,
  outcome: VerifyOutcome,
  reason: string,
  evidence = "",
  measurements: VerifyMeasurement[] = [],
) {
  authorize(ctx, "task_verify");
  const task = loadTask(ctx.taskId);

  if (task.status !== "VERIFYING") {
    throw new McpAuthError(
      `task_verify requires status VERIFYING, got ${task.status}`,
    );
  }

  const cleanMeasurements = (Array.isArray(measurements) ? measurements : [])
    .filter((m) => m && typeof m.metric === "string" && typeof m.after === "string")
    .map((m) => ({
      metric: m.metric.trim(),
      ...(m.before ? { before: String(m.before).trim() } : {}),
      after: String(m.after).trim(),
      source: String(m.source ?? "").trim(),
    }))
    .filter((m) => m.metric && m.after);
  if (cleanMeasurements.length) {
    db.update(tasks)
      .set({ measured_impact: JSON.stringify(cleanMeasurements), updated_at: now() })
      .where(eq(tasks.id, ctx.taskId))
      .run();
  }

  const detail = evidence ? `${reason}\n\nEvidence:\n${evidence}` : reason;

  if (outcome === "pass") {
    task_append_comment(ctx, "VERIFYING", `verified: ${detail}`);
    const moved = transitionStatus({
      taskId: ctx.taskId,
      from: "VERIFYING",
      to: "PUBLISHING",
    });
    if (!moved) throw new McpAuthError("transition lost; retry");
    // No cache to keep warm (publishing is LLM-free) — kicked purely to cut
    // the cron wait off time-to-PR, consistent with the other verdicts.
    kickStage("publishing");
    return { ok: true, status: "PUBLISHING" };
  }

  // fail path — append reason and check the brake
  task_append_comment(ctx, "VERIFYING", `verify failed: ${detail}`);

  const max = getMaxAiDeclineCycles();
  const count = countAiAutoActions(ctx.taskId, "VERIFYING");
  if (count >= max) {
    task_append_comment(
      ctx,
      "VERIFYING",
      "max verify cycles reached — deferring to human",
    );
    const parked = transitionStatus({
      taskId: ctx.taskId,
      from: "VERIFYING",
      to: "NEEDS_REVIEW",
      pendingReviewKind: "verify",
    });
    if (!parked) throw new McpAuthError("forced transition lost; retry");
    // The pipeline tapped out — stop feeding new work until a human clears it.
    pauseLineForHuman({
      taskId: ctx.taskId,
      stage: "verify",
      summary: `Verification couldn't pass ${ctx.taskId} after repeated tries`,
      detail: detail,
    });
    return { ok: true, status: "NEEDS_REVIEW", forced: true };
  }

  const moved = transitionStatus({
    taskId: ctx.taskId,
    from: "VERIFYING",
    to: "IMPLEMENTING",
  });
  if (!moved) throw new McpAuthError("fail transition lost; retry");
  kickStage("implementing");
  return { ok: true, status: "IMPLEMENTING" };
}

type Escalation = {
  question: string;
  options: string[];
  evidence: string;
  origin_stage: Stage;
  resolver_tried: boolean;
  decision?: string;
  needs_human?: boolean;
  // Lifetime escalations on this task. Without it, escalate → auto-resolve →
  // back-to-stage → re-escalate cycles forever (each escalate used to reset
  // resolver_tried). Past the cap the resolver is skipped and a human decides.
  escalation_count?: number;
};

/**
 * Escalate a genuine judgment fork the stage can't resolve from context, instead
 * of guessing. Records the question + options + evidence, remembers the origin
 * stage to return to, and parks at NEEDS_REVIEW(question). The auto-resolver
 * (higher-effort Opus pass) picks it up; if that also defers, it lands on a
 * human. Picking does NOT pause here — the pipeline still has the resolver shot;
 * the pause happens only if it reaches a human (task_resolve "defer").
 */
export function task_escalate(
  ctx: McpAuthContext,
  question: string,
  options: string[],
  evidence = "",
) {
  authorize(ctx, "task_escalate");
  const q = question.trim();
  if (!q) throw new McpAuthError("task_escalate requires a question");
  const task = loadTask(ctx.taskId);

  // Lifetime cap: each escalate used to reset resolver_tried, so a stage could
  // cycle escalate → auto-resolve → re-escalate forever. Past the cap, skip the
  // resolver (latch resolver_tried) and pause for a human.
  let prevCount = 0;
  try {
    prevCount = task.escalation
      ? ((JSON.parse(task.escalation) as Escalation).escalation_count ?? 0)
      : 0;
  } catch {
    prevCount = 0;
  }
  const escalationCount = prevCount + 1;
  const exhausted = escalationCount > getMaxAiDeclineCycles();

  const escalation: Escalation = {
    question: q,
    options: Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean) : [],
    evidence: (evidence ?? "").trim(),
    origin_stage: ctx.stage,
    resolver_tried: exhausted,
    ...(exhausted ? { needs_human: true } : {}),
    escalation_count: escalationCount,
  };
  db.update(tasks)
    .set({ escalation: JSON.stringify(escalation), updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();

  task_append_comment(
    ctx,
    STATUS_BY_STAGE[ctx.stage] ?? task.status,
    `Escalated a judgment call: ${q}${escalation.options.length ? `\nOptions: ${escalation.options.join(" | ")}` : ""}` +
      (exhausted
        ? `\n\nEscalation #${escalationCount} on this task — past the cap; skipping auto-resolution, a human must decide.`
        : ""),
  );

  const moved = transitionStatus({
    taskId: ctx.taskId,
    from: task.status,
    to: "NEEDS_REVIEW",
    pendingReviewKind: "question",
  });
  if (!moved) throw new McpAuthError("escalate transition lost; retry");

  if (exhausted) {
    pauseLineForHuman({
      taskId: ctx.taskId,
      stage: ctx.stage,
      summary: `${ctx.taskId} escalated ${escalationCount}× — past the cap, needs your decision`,
      detail: q,
    });
  }
  return { ok: true, status: "NEEDS_REVIEW", kind: "question" };
}

export type ResolveOutcome = "decided" | "defer";

/**
 * Answer an escalation. Used by the auto-resolver (higher-effort Opus pass).
 * "decided" → write the decision as an instruction tagged to the origin stage
 * and send the task back there to continue. "defer" → genuinely needs a human:
 * keep NEEDS_REVIEW(question), pause the line, file a persistent warning.
 */
export function task_resolve(
  ctx: McpAuthContext,
  outcome: ResolveOutcome,
  decision: string,
  rationale = "",
) {
  authorize(ctx, "task_resolve");
  const task = loadTask(ctx.taskId);
  if (task.status !== "NEEDS_REVIEW" || task.pending_review_kind !== "question") {
    throw new McpAuthError(
      `task_resolve requires NEEDS_REVIEW(question), got ${task.status}(${task.pending_review_kind})`,
    );
  }
  const esc = (task.escalation ? JSON.parse(task.escalation) : null) as Escalation | null;
  if (!esc) throw new McpAuthError("no escalation on task");

  if (outcome === "decided") {
    const d = decision.trim();
    if (!d) throw new McpAuthError("task_resolve 'decided' requires a decision");
    const next: Escalation = { ...esc, resolver_tried: true, decision: d };
    db.update(tasks)
      .set({ escalation: JSON.stringify(next), updated_at: now() })
      .where(eq(tasks.id, ctx.taskId))
      .run();
    const originStatus = STATUS_BY_STAGE[esc.origin_stage] ?? "IMPLEMENTING";
    task_append_comment(
      ctx,
      originStatus,
      `Resolved (auto): ${d}${rationale ? `\n\nWhy: ${rationale}` : ""}`,
    );
    const moved = transitionStatus({
      taskId: ctx.taskId,
      from: "NEEDS_REVIEW",
      to: originStatus,
    });
    if (!moved) throw new McpAuthError("resolve transition lost; retry");
    return { ok: true, status: originStatus, resolved: true };
  }

  // defer — genuinely needs a human; stop the line.
  const next: Escalation = { ...esc, resolver_tried: true, needs_human: true };
  db.update(tasks)
    .set({ escalation: JSON.stringify(next), updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  task_append_comment(
    ctx,
    "NEEDS_REVIEW",
    `Couldn't resolve automatically — needs your call.${rationale ? ` ${rationale}` : ""}\n\nQuestion: ${esc.question}${esc.options.length ? `\nOptions: ${esc.options.join(" | ")}` : ""}`,
  );
  pauseLineForHuman({
    taskId: ctx.taskId,
    stage: esc.origin_stage,
    summary: `Needs your decision on ${ctx.taskId}: ${esc.question}`,
    detail: esc.evidence,
  });
  return { ok: true, status: "NEEDS_REVIEW", deferred: true };
}

const STATUS_BY_STAGE: Partial<Record<Stage, Task["status"]>> = {
  planning: "PLANNING",
  implementing: "IMPLEMENTING",
  ai_review: "AI-REVIEW",
  verify: "VERIFYING",
  publishing: "PUBLISHING",
};

