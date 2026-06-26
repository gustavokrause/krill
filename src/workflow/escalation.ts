import { and, eq } from "drizzle-orm";
import { resolve as resolvePath } from "node:path";
import { db } from "@/db/client";
import { globalConfig, tasks, type Task } from "@/db/schema";
import { runStage } from "@/claude/usage";
import { TimeoutError } from "@/claude/errors";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { resolveProjectPath } from "@/lib/api/util";
import { appendAiComment } from "./comment";
import { pauseLineForHuman } from "./blockers";
import {
  getBaseUrl,
  getClaimTtl,
  getProject,
  getRunnerTimeoutMs,
  loadPrompt,
} from "./stages/context";
import { now } from "./types";

type Escalation = {
  question: string;
  options: string[];
  evidence: string;
  origin_stage: string;
  resolver_tried: boolean;
  decision?: string;
  needs_human?: boolean;
};

/** Auto-resolve at most one open escalation per tick: a higher-effort Opus pass
 *  that either decides (→ back to origin stage, via task_resolve) or defers to a
 *  human. Atomically latches `resolver_tried` so it runs once and never loops.
 *  Returns the task id it handled, or null. */
export async function runEscalationResolver(): Promise<string | null> {
  const cfg = db
    .select({
      automation: globalConfig.automation_enabled,
      auto: globalConfig.escalation_auto_resolve,
    })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  if (!cfg || !cfg.automation || !cfg.auto) return null;

  // Pick + latch atomically so a concurrent tick can't double-run the pass.
  const task = db.transaction((tx) => {
    const candidates = tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "NEEDS_REVIEW"),
          eq(tasks.pending_review_kind, "question"),
          eq(tasks.blocked, false),
        ),
      )
      .all();
    const next = candidates.find((t) => {
      const esc = parse(t);
      return esc && !esc.resolver_tried;
    });
    if (!next) return null;
    const esc = parse(next)!;
    tx.update(tasks)
      .set({
        escalation: JSON.stringify({ ...esc, resolver_tried: true }),
        updated_at: now(),
      })
      .where(eq(tasks.id, next.id))
      .run();
    return next;
  });

  if (!task) return null;
  const esc = parse(task)!;
  const project = getProject(task.project_id);
  const cwd =
    task.worktree_path ??
    task.workspace_path ??
    resolveProjectPath(project.folder_path);

  const ttl = getClaimTtl("ai_review");
  const token = issueToken(task.id, "ai_review", ttl);
  try {
    const prompt = loadPrompt("resolve.md");
    try {
      await runStage({
        stage: "ai_review",
        task,
        project,
        prompt,
        mcpToken: token,
        baseUrl: getBaseUrl(),
        cwd,
        timeoutMs: getRunnerTimeoutMs(ttl),
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        appendAiComment(task.id, `escalation resolver timed out after ${ttl}s`, "NEEDS_REVIEW");
      }
      // fall through to the post-run defer check
    }

    // If the pass didn't call task_resolve (crash/timeout/no decision), the task
    // is still NEEDS_REVIEW(question) with no decision — treat it as a defer so
    // the line pauses and a human picks it up instead of it sitting silently.
    const after = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
    const escAfter = after ? parse(after) : null;
    if (
      after &&
      after.status === "NEEDS_REVIEW" &&
      after.pending_review_kind === "question" &&
      escAfter &&
      !escAfter.decision &&
      !escAfter.needs_human
    ) {
      db.update(tasks)
        .set({ escalation: JSON.stringify({ ...escAfter, needs_human: true }), updated_at: now() })
        .where(eq(tasks.id, task.id))
        .run();
      appendAiComment(
        task.id,
        `Auto-resolution didn't reach a decision — needs your call.\n\nQuestion: ${esc.question}${esc.options.length ? `\nOptions: ${esc.options.join(" | ")}` : ""}`,
        "NEEDS_REVIEW",
      );
      pauseLineForHuman({
        taskId: task.id,
        stage: esc.origin_stage,
        summary: `Needs your decision on ${task.id}: ${esc.question}`,
        detail: esc.evidence,
      });
    }
    return task.id;
  } finally {
    revokeToken(token);
  }
}

function parse(t: Task): Escalation | null {
  if (!t.escalation) return null;
  try {
    return JSON.parse(t.escalation) as Escalation;
  } catch {
    return null;
  }
}
