import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { comments, globalConfig, tasks } from "@/db/schema";
import { getRunner } from "@/claude";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import {
  abortMerge,
  commitMerge,
  ensurePr,
  getPrState,
  hasRemote,
  mergeOriginInto,
  pushMerge,
  resetWorktreeToOriginBranch,
} from "@/git";
import { resolveProjectPath } from "@/lib/api/util";
import { claim } from "../claim";
import { applyTransitionSideEffects } from "../cleanup";
import { appendAiComment } from "../comment";
import { resolvePublishPolicy } from "../publish-policy";
import { finishMerge, autoFinishEligible } from "../finish";
import { tripAutoFinishBreaker } from "../breaker";
import { countAiAutoActions, MANUAL_AI_COMMENT_PREFIX } from "../loop-brake";
import { releaseClaim, transitionStatus } from "../transition";
import { now } from "../types";
import {
  getBaseUrl,
  getClaimTtl,
  getRunnerTimeoutMs,
  getProject,
  loadPrompt,
} from "./context";

export { appendAiComment };

function getMaxAiDeclineCycles(): number {
  const row = db
    .select({ n: globalConfig.max_ai_decline_cycles })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  return row?.n ?? 3;
}

function isSolveConflictsEnabled(): boolean {
  const row = db
    .select({ v: globalConfig.publishing_solve_conflicts })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  return row?.v ?? true;
}

/**
 * Deliverable routing (A2). If the task is auto-finish eligible (auto_publish +
 * project.allow_auto_finish), merge to main and go straight to DONE — no human
 * gate. Otherwise stop at NEEDS_REVIEW(deliverable). A failed auto-merge falls
 * back to human review so work is never lost. Re-reads the task for a fresh
 * delivery_url.
 */
async function deliverOrAutoFinish(
  taskId: string,
  project: Parameters<typeof finishMerge>[1],
  workerId: string,
): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  // PR-less direct-to-main delivery (create_pr off): branch already pushed, no PR.
  const isBranch = !!task?.delivery_url?.startsWith("branch:");
  const isLocal = !!task?.delivery_url?.startsWith("local:");
  const policy = await resolvePublishPolicy(project);
  // Push off on a repo that HAS a remote: the local merge leaves origin behind.
  // Don't auto-finish that silently — a human must know to push it themselves.
  const localOnRemote =
    isLocal && (await hasRemote(resolveProjectPath(project.folder_path)));
  let autoFinishFailed = false;
  // Auto-finish only when the project actually integrates (merge_to_main on) and
  // we're not leaving a remote behind. Otherwise defer to the human gate.
  if (
    task &&
    autoFinishEligible(task, project) &&
    policy.mergeToMain &&
    !localOnRemote
  ) {
    try {
      await finishMerge(task, project);
      appendAiComment(
        taskId,
        isBranch
          ? `auto-finished — merged \`${task.branch}\` directly into ${project.default_branch} and pushed to origin (no PR, no human gate)`
          : "auto-finished (auto_publish + allow_auto_finish) — merged to main, no human gate",
      );
      const moved = transitionStatus({ taskId, from: "PUBLISHING", to: "DONE", endedAt: now() });
      if (moved) await applyTransitionSideEffects(taskId, "PUBLISHING", "DONE");
      else releaseClaim(taskId, workerId);
      return;
    } catch (err) {
      appendAiComment(
        taskId,
        `auto-finish merge failed, routing to deliverable review: ${(err as Error).message}`,
        "NEEDS_REVIEW",
      );
      autoFinishFailed = true;
    }
  }
  // Human-gated landing — tell the reviewer what Approve will (or won't) do.
  if (!autoFinishFailed) {
    if (!policy.mergeToMain) {
      appendAiComment(
        taskId,
        `merge_to_main is off — krill won't merge this. Merge the ${isBranch ? "branch" : "PR"} yourself; Approve marks the task DONE without merging.`,
        "NEEDS_REVIEW",
      );
    } else if (localOnRemote) {
      appendAiComment(
        taskId,
        `push_remote is off but this repo has a remote — Approve merges into local ${project.default_branch} only; origin will NOT be pushed. Push it manually after.`,
        "NEEDS_REVIEW",
      );
    } else if (isBranch) {
      appendAiComment(
        taskId,
        `branch \`${task!.branch}\` pushed to origin, no PR (create_pr off) — approve to merge into ${project.default_branch} and push, or merge the branch manually`,
        "NEEDS_REVIEW",
      );
    }
  }
  const moved = transitionStatus({
    taskId,
    from: "PUBLISHING",
    to: "NEEDS_REVIEW",
    pendingReviewKind: "deliverable",
  });
  if (moved) await applyTransitionSideEffects(taskId, "PUBLISHING", "NEEDS_REVIEW");
  else releaseClaim(taskId, workerId);
  // A3 circuit breaker: a failed auto-finish counts toward the project's
  // failure budget; trip + pause the project if a batch is snowballing.
  if (autoFinishFailed) tripAutoFinishBreaker(project.id, taskId);
}


export async function runPublishing(workerId: string): Promise<string | null> {
  const ttl = getClaimTtl("publishing");
  const task = claim({ stage: "publishing", workerId, ttlSeconds: ttl });
  if (!task) return null;

  const project = getProject(task.project_id);

  try {
    if (project.has_repo) {
      await publishRepo(task.id, workerId, ttl);
    } else {
      await publishWorkspace(task.id);
    }
    return task.id;
  } catch (err) {
    releaseClaim(task.id, workerId);
    throw err;
  }
}

async function publishRepo(
  taskId: string,
  workerId: string,
  ttl: number,
): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  const project = getProject(task.project_id);
  if (!task.worktree_path || !task.branch) {
    releaseClaim(taskId, workerId);
    throw new Error(`task ${taskId} missing worktree/branch in PUBLISHING`);
  }

  // Local path (A1): remote-less project. No origin reset, no PR, no push —
  // hand the branch to the deliverable gate; the merge-to-main happens locally
  // on approval (transition DONE).
  const policy = await resolvePublishPolicy(project);
  if (!policy.pushRemote) {
    const localUrl = `local:${task.branch}`;
    if (task.delivery_url !== localUrl) {
      db.update(tasks)
        .set({ delivery_url: localUrl, updated_at: now() })
        .where(eq(tasks.id, task.id))
        .run();
    }
    await deliverOrAutoFinish(task.id, project, workerId);
    return;
  }

  // If a PR was merged externally (e.g. tech lead squash-merged on GitHub),
  // skip review gate and mark DONE directly — merged = approved.
  if (task.delivery_url && /^https?:\/\//.test(task.delivery_url)) {
    const prState = await getPrState(task.worktree_path, task.delivery_url);
    if (prState === "MERGED") {
      appendAiComment(task.id, "PR merged externally — marking DONE");
      const moved = transitionStatus({
        taskId: task.id,
        from: "PUBLISHING",
        to: "DONE",
        endedAt: now(),
      });
      if (moved) {
        await applyTransitionSideEffects(task.id, "PUBLISHING", "DONE");
      } else {
        releaseClaim(taskId, workerId);
      }
      return;
    }
  }

  // PR-first per OVERVIEW.md: open the PR before any merge attempt so the
  // human always has a tangible artifact to look at, even if the merge
  // fails repeatedly. When create_pr is OFF the branch is still synced and
  // pushed (push_remote is on here), but no PR is opened — delivery is the
  // branch ref and the task stops at deliverable review (see result.ok below).
  if (policy.createPr) {
    const pr = await ensurePr({
      cwd: task.worktree_path,
      base: project.default_branch,
      head: task.branch,
      title: `${task.id}: ${task.name}`,
      body: prBody(task.id, task.plan, task.checklist),
    });
    if (task.delivery_url !== pr.url) {
      db.update(tasks)
        .set({ delivery_url: pr.url, updated_at: now() })
        .where(eq(tasks.id, task.id))
        .run();
    }
  } else {
    const branchUrl = `branch:${task.branch}`;
    if (task.delivery_url !== branchUrl) {
      db.update(tasks)
        .set({ delivery_url: branchUrl, updated_at: now() })
        .where(eq(tasks.id, task.id))
        .run();
    }
  }

  // Idempotent sync — picks up any human-side resolution pushed to GitHub
  // since the last tick. No-op when already in sync.
  await resetWorktreeToOriginBranch(task.worktree_path, task.branch);

  const result = await mergeOriginInto(
    task.worktree_path,
    project.default_branch,
  );

  if (result.ok) {
    await pushMerge(task.worktree_path, task.branch);
    // create_pr OFF leaves delivery as branch:<name>; deliverOrAutoFinish then
    // either auto-finishes (merge to main + push origin, no PR) when eligible,
    // or stops at deliverable review with a pointer comment.
    await deliverOrAutoFinish(task.id, project, workerId);
    return;
  }

  // Conflict path — gated by {publishing_solve_conflicts}.
  const conflictedSummary = result.conflictedFiles.join(", ");
  appendAiComment(
    task.id,
    `merge-into conflict: ${conflictedSummary}`,
    "NEEDS_REVIEW",
  );

  if (!isSolveConflictsEnabled()) {
    await routeConflictResolverDisabled({
      taskId: task.id,
      workerId,
      worktreePath: task.worktree_path,
      conflictedSummary,
    });
    return;
  }

  const resolved = await attemptAiConflictResolve(task.id, ttl);

  if (resolved) {
    try {
      await commitMerge(task.worktree_path, `merge origin/${project.default_branch} into ${task.branch}`);
      await pushMerge(task.worktree_path, task.branch);
      await deliverOrAutoFinish(task.id, project, workerId);
      return;
    } catch (err) {
      appendAiComment(
        task.id,
        `conflict commit failed: ${(err as Error).message}`,
      );
      await abortMerge(task.worktree_path);
    }
  } else {
    await abortMerge(task.worktree_path);
  }

  // Resolution failed — apply brake.
  appendAiComment(
    task.id,
    `conflict resolution failed: ${conflictedSummary}`,
    "NEEDS_REVIEW",
  );

  const max = getMaxAiDeclineCycles();
  const aiActions = countAiAutoActions(task.id);
  if (aiActions >= max) {
    appendAiComment(
      task.id,
      "max AI decline cycles reached — deferring to human (PR already exists)",
      "NEEDS_REVIEW",
    );
    const moved = transitionStatus({
      taskId: task.id,
      from: "PUBLISHING",
      to: "NEEDS_REVIEW",
      pendingReviewKind: "conflict",
    });
    if (moved) {
      await applyTransitionSideEffects(task.id, "PUBLISHING", "NEEDS_REVIEW");
    } else {
      releaseClaim(taskId, workerId);
    }
    return;
  }

  // Brake not yet tripped — release claim, next tick retries.
  releaseClaim(taskId, workerId);
}

export async function routeConflictResolverDisabled(opts: {
  taskId: string;
  workerId: string;
  worktreePath: string;
  conflictedSummary: string;
}): Promise<void> {
  appendAiComment(
    opts.taskId,
    `conflict resolver disabled — resolve in GitHub then click Retry PUBLISHING, or Solve with Sonnet, or send back to IMPLEMENTING for a redo: ${opts.conflictedSummary}`,
    "NEEDS_REVIEW",
  );
  try {
    await abortMerge(opts.worktreePath);
  } catch {
    // Worktree may not exist in tests, or merge was never started — non-fatal.
  }
  const moved = transitionStatus({
    taskId: opts.taskId,
    from: "PUBLISHING",
    to: "NEEDS_REVIEW",
    pendingReviewKind: "conflict",
  });
  if (moved) {
    await applyTransitionSideEffects(opts.taskId, "PUBLISHING", "NEEDS_REVIEW");
  } else {
    releaseClaim(opts.taskId, opts.workerId);
  }
}

export async function attemptAiConflictResolve(
  taskId: string,
  ttl: number,
  opts: { manual?: boolean } = {},
): Promise<boolean> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  const project = getProject(task.project_id);
  if (!task.worktree_path) return false;

  const token = issueToken(task.id, "publishing", ttl);
  try {
    await getRunner().run({
      stage: "publishing",
      task,
      project,
      prompt: loadPrompt("publishing-conflict.md"),
      mcpToken: token,
      baseUrl: getBaseUrl(),
      cwd: task.worktree_path,
      timeoutMs: getRunnerTimeoutMs(ttl),
    });
    return true;
  } catch (err) {
    const prefix = opts.manual ? MANUAL_AI_COMMENT_PREFIX : "";
    appendAiComment(
      task.id,
      `${prefix}ai conflict-resolve runner failed: ${(err as Error).message}`,
      opts.manual ? "NEEDS_REVIEW" : "PUBLISHING",
    );
    return false;
  } finally {
    revokeToken(token);
  }
}

async function publishWorkspace(taskId: string): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  const project = getProject(task.project_id);

  if (!task.workspace_path) {
    throw new Error(`task ${taskId} missing workspace_path in PUBLISHING`);
  }
  const folder = resolveProjectPath(project.folder_path);
  const workspace = task.workspace_path;
  const explicit = new Set(task.affected_paths);

  const moved: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else {
        const rel = relative(workspace, abs).replaceAll("\\", "/");
        const dest = resolve(folder, rel);
        if (existsSync(dest) && !explicit.has(rel)) continue;
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(abs, dest);
        moved.push(rel);
      }
    }
  };
  walk(workspace);

  rmSync(workspace, { recursive: true, force: true });

  const root = task.affected_paths[0] ?? moved[0] ?? `.tasks/${task.id}`;
  const delivery_url = `file://${resolve(folder, root)}`;
  db.update(tasks)
    .set({
      delivery_url,
      workspace_path: null,
      updated_at: now(),
    })
    .where(eq(tasks.id, task.id))
    .run();

  const ok = transitionStatus({
    taskId: task.id,
    from: "PUBLISHING",
    to: "NEEDS_REVIEW",
    pendingReviewKind: "deliverable",
  });
  if (ok) {
    await applyTransitionSideEffects(task.id, "PUBLISHING", "NEEDS_REVIEW");
  }
}

function prBody(taskId: string, plan: string, checklist: string): string {
  const implNotes = db
    .select()
    .from(comments)
    .where(eq(comments.task_id, taskId))
    .all()
    .filter((c) => c.stage === "IMPLEMENTING")
    .sort((a, b) => a.at - b.at)
    .map((c) => `- (${c.author}) ${c.text}`)
    .join("\n");

  const parts = [
    plan || "_no plan recorded_",
    "",
    "## Checklist (final state)",
    checklist || "_no checklist recorded_",
  ];
  if (implNotes) {
    parts.push("", "## Implementation notes", implNotes);
  }
  return parts.join("\n");
}
