"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  Comment,
  GlobalConfig,
  Project,
  ReviewKind,
  Task,
  TaskStatus,
} from "@/db/schema";
import { api, type StageUsageRollup } from "@/lib/client/api";
import { formatTokens } from "@/lib/client/format";
import { countAiAutoActionsFromComments } from "@/lib/ai-comments";
import { useEventSource } from "@/lib/client/use-event-source";
import { Button } from "@/components/ui/button";
import { PriorityBadge, StatusBadge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CancelTaskDialog, type CancelOptions } from "@/components/board/cancel-task-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CornerUpLeft,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type MoveIntent = "approve" | "forward" | "back" | "cancel";

function intentFor(
  from: TaskStatus,
  to: TaskStatus,
  kind: ReviewKind | null,
): MoveIntent {
  if (to === "DONE") return "approve";
  if (to === "CANCELED") return "cancel";
  if (from === "CANCELED") return "forward";
  if (to === "BACKLOG") return "back";
  // NEEDS_REVIEW(plan) → IMPLEMENTING is approve; → PLANNING is decline.
  if (from === "NEEDS_REVIEW" && kind === "plan") {
    if (to === "IMPLEMENTING") return "approve";
    if (to === "PLANNING") return "back";
  }
  // NEEDS_REVIEW(deliverable | conflict | empty) → IMPLEMENTING is decline/redo.
  if (
    from === "NEEDS_REVIEW" &&
    (kind === "deliverable" || kind === "conflict" || kind === "empty" || kind === "verify" || kind === "declined") &&
    to === "IMPLEMENTING"
  ) {
    return "back";
  }
  // NEEDS_REVIEW(conflict) → PUBLISHING is a retry (forward).
  if (from === "NEEDS_REVIEW" && kind === "conflict" && to === "PUBLISHING") {
    return "forward";
  }
  return "forward";
}

function labelFor(
  from: TaskStatus,
  to: TaskStatus,
  intent: MoveIntent,
  kind: ReviewKind | null,
): string {
  if (from === "CANCELED") return `Restart (${to})`;
  if (from === "NEEDS_REVIEW" && kind === "conflict" && to === "PUBLISHING") {
    return "Retry PUBLISHING";
  }
  if (from === "NEEDS_REVIEW" && kind === "verify" && to === "VERIFYING") {
    return "Retry VERIFYING";
  }
  // Empty task → DONE isn't an "Approve" of a deliverable; it's accepting a
  // no-op as complete.
  if (from === "NEEDS_REVIEW" && kind === "empty" && to === "DONE") {
    return "Mark DONE (no change)";
  }
  return INTENT_STYLE[intent].label(to);
}

const INTENT_STYLE: Record<
  MoveIntent,
  { icon: LucideIcon; label: (s: TaskStatus) => string; cls: string }
> = {
  approve: {
    icon: Check,
    label: (s) => `Approve (${s})`,
    cls: "border-success/30 bg-success/5 text-success hover:bg-success/10",
  },
  forward: {
    icon: ArrowRight,
    label: (s) => `Move to ${s}`,
    cls: "border-border bg-bg text-text hover:bg-surface",
  },
  back: {
    icon: CornerUpLeft,
    label: (s) => `Back to ${s}`,
    cls: "border-warning/30 bg-warning/5 text-warning hover:bg-warning/10",
  },
  cancel: {
    icon: X,
    label: () => `Cancel`,
    cls: "border-muted/30 bg-muted/5 text-muted hover:bg-muted/10",
  },
};

const INTENT_ORDER: Record<MoveIntent, number> = {
  approve: 0,
  forward: 1,
  back: 2,
  cancel: 3,
};

const STAGE_TO_STATUS: Record<string, TaskStatus> = {
  planning: "PLANNING",
  implementing: "IMPLEMENTING",
  ai_review: "AI-REVIEW",
  verify: "VERIFYING",
  publishing: "PUBLISHING",
};

type EscalationShape = {
  question?: string;
  options?: string[];
  evidence?: string;
  origin_stage?: string;
  decision?: string;
  needs_human?: boolean;
};

function parseEscalation(task: Task): EscalationShape | null {
  if (!task.escalation) return null;
  try {
    return JSON.parse(task.escalation) as EscalationShape;
  } catch {
    return null;
  }
}

function originStageStatus(task: Task): TaskStatus | null {
  const esc = parseEscalation(task);
  const s = esc?.origin_stage;
  return s && STAGE_TO_STATUS[s] ? STAGE_TO_STATUS[s] : null;
}

function nextStatusesFor(task: Task): TaskStatus[] {
  switch (task.status) {
    case "BACKLOG":
      return ["TODO", "CANCELED"];
    case "TODO":
      return ["BACKLOG", "PLANNING", "CANCELED"];
    case "PLANNING":
      return ["BACKLOG", "CANCELED"];
    case "IMPLEMENTING":
      return ["BACKLOG", "CANCELED"];
    case "AI-REVIEW":
      return ["BACKLOG", "CANCELED"];
    case "VERIFYING":
      return ["BACKLOG", "CANCELED"];
    case "PUBLISHING":
      return ["BACKLOG", "CANCELED"];
    case "NEEDS_REVIEW":
      switch (task.pending_review_kind) {
        case "plan":
          return ["IMPLEMENTING", "PLANNING", "BACKLOG", "CANCELED"];
        case "deliverable":
          return ["DONE", "IMPLEMENTING", "BACKLOG", "CANCELED"];
        case "declined":
          // AI-REVIEW rejected the change past the retry limit. There is NO
          // merged PR — so NO DONE here (that would mark complete without a
          // merge, the exact orphan-bug we're guarding against). Fix it
          // (IMPLEMENTING), override-ship through proper publish (PUBLISHING),
          // or shelve/abandon.
          return ["IMPLEMENTING", "PUBLISHING", "BACKLOG", "CANCELED"];
        case "conflict":
          return ["PUBLISHING", "IMPLEMENTING", "BACKLOG", "CANCELED"];
        case "verify":
          // Verification couldn't prove the change. Retry VERIFYING (e.g. after
          // a transient/infra failure — nothing wrong with the code), send back
          // to IMPLEMENTING to fix code, or override the gate straight to
          // PUBLISHING if the human is satisfied.
          return ["VERIFYING", "IMPLEMENTING", "PUBLISHING", "BACKLOG", "CANCELED"];
        case "question": {
          // Escalated judgment call the resolver deferred. Answer it (comment
          // your decision), then send the task back to the stage it came from.
          const origin = originStageStatus(task);
          const back: TaskStatus[] = origin ? [origin] : ["PLANNING", "IMPLEMENTING"];
          return [...back, "BACKLOG", "CANCELED"];
        }
        case "empty":
          // Nothing was shipped, but a no-op can still be a valid close: the
          // task may already be satisfied / need no change. Allow DONE (marks
          // complete, no merge — there's no delivery_url) alongside re-run or
          // shelve. CANCELED is reserved for "abandon" since it trips the
          // auto-finish breaker and cascade-cancels dependents.
          return ["DONE", "IMPLEMENTING", "BACKLOG", "CANCELED"];
        default:
          return ["BACKLOG", "CANCELED"];
      }
    case "DONE":
      return [];
    case "CANCELED":
      return ["BACKLOG", "TODO"];
  }
}

export function TaskDetail({
  initialTask,
  initialComments,
  project,
  initialConfig,
}: {
  initialTask: Task;
  initialComments: Comment[];
  project: Project | null;
  initialConfig: GlobalConfig;
}) {
  const router = useRouter();
  const toast = useToast();
  const [task, setTask] = useState(initialTask);
  const [comments, setComments] = useState(initialComments);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [config, setConfig] = useState<GlobalConfig>(initialConfig);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  useEventSource({
    any: (e) => {
      if (e.type === "task.updated" && e.task.id === task.id) {
        setTask(e.task);
        // Resolve CTA un-disables once status leaves PUBLISHING.
        if (e.task.status !== "PUBLISHING") setResolving(false);
      }
      if (e.type === "task.transitioned" && e.task.id === task.id) {
        setTask(e.task);
        if (e.task.status !== "PUBLISHING") setResolving(false);
      }
      if (e.type === "comment.appended" && e.comment.task_id === task.id) {
        setComments((prev) =>
          prev.some((c) => c.id === e.comment.id) ? prev : [...prev, e.comment],
        );
      }
      if (e.type === "task.deleted" && e.taskId === task.id) {
        toast.push({ variant: "warning", title: "Task was deleted" });
        router.push("/");
      }
      if (e.type === "config.changed") {
        setConfig(e.config);
      }
    },
  });

  const allowed = nextStatusesFor(task);
  const declineCycles = useMemo(
    () => countAiAutoActionsFromComments(comments),
    [comments],
  );

  const transitionTo = useCallback(
    async (to: TaskStatus, cancelOpts?: CancelOptions) => {
      if (busy) return;
      setBusy(true);
      try {
        const pendingNote =
          task.status === "NEEDS_REVIEW" && to !== "DONE" && commentText.trim()
            ? commentText.trim()
            : undefined;
        const next = await api.transitionTask(task.id, {
          to,
          ...(pendingNote ? { comment: { author: "human", text: pendingNote } } : {}),
          ...(cancelOpts ? { cancel_options: cancelOpts } : {}),
        });
        setTask(next);
        if (pendingNote) setCommentText("");
        toast.push({
          variant: "success",
          title: `Moved to ${to}`,
        });
      } catch (err) {
        toast.push({
          variant: "danger",
          title: "Transition failed",
          description: (err as Error).message,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, task.id, task.status, commentText, toast],
  );

  const submitComment = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!commentText.trim() || busy) return;
      setBusy(true);
      try {
        await api.appendComment(task.id, {
          author: "human",
          stage: task.status,
          text: commentText.trim(),
        });
        setCommentText("");
      } catch (err) {
        toast.push({
          variant: "danger",
          title: "Comment failed",
          description: (err as Error).message,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, commentText, task.id, task.status, toast],
  );

  const sortedComments = useMemo(
    () => [...comments].sort((a, b) => a.at - b.at),
    [comments],
  );

  type ReviewContext = {
    kind: ReviewKind;
    title: string;
    message: string;
    showSolveWithSonnet: boolean;
  };

  const reviewContext = useMemo<ReviewContext | null>(() => {
    if (task.status !== "NEEDS_REVIEW") return null;
    const kind = task.pending_review_kind;
    if (!kind) return null;
    if (kind === "plan") {
      return {
        kind,
        title: "Plan review",
        message:
          "Approve to start implementation, or send back to PLANNING to revise.",
        showSolveWithSonnet: false,
      };
    }
    if (kind === "deliverable") {
      const isBranch = task.delivery_url?.startsWith("branch:") ?? false;
      const isLocal = task.delivery_url?.startsWith("local:") ?? false;
      const isPr = (task.delivery_url?.startsWith("http") ?? false);
      const mergeOff = project?.merge_to_main === false;
      const draftPr =
        isPr && (task.draft_pr ?? project?.draft_pr ?? false) === true;
      return {
        kind,
        title: "Deliverable review",
        message: !project?.has_repo
          ? "Review the published files. Approve to mark DONE, or send back to IMPLEMENTING for a redo."
          : mergeOff
            ? `Merge to main is off — krill won't merge this. Merge the ${isBranch ? "branch" : "PR"} yourself; Approve marks DONE without merging, or send back to IMPLEMENTING.`
            : isBranch
              ? "No PR (create_pr off). The branch is on origin. Approve to merge it into main and push, or send back to IMPLEMENTING for a redo."
              : isLocal
                ? "Local merge — no PR. Approve to merge into main on this machine (origin is NOT pushed — push manually after), or send back to IMPLEMENTING."
                : draftPr
                  ? "Draft PR — not auto-merged. Approve to mark it ready and squash-merge, or send back to IMPLEMENTING for a redo."
                  : "Review the PR. Approve to squash-merge to main, or send back to IMPLEMENTING for a redo.",
        showSolveWithSonnet: false,
      };
    }
    if (kind === "empty") {
      return {
        kind,
        title: "Empty result",
        message:
          "Implementation produced no commits — nothing to ship. Mark DONE if no change was needed, re-run IMPLEMENTING, or cancel.",
        showSolveWithSonnet: false,
      };
    }
    if (kind === "verify") {
      return {
        kind,
        title: "Verification failed",
        message:
          "VERIFYING couldn't prove the change meets its acceptance after repeated tries. Retry VERIFYING if it failed for a transient/infra reason (the code is fine), send back to IMPLEMENTING to fix the code, or override to PUBLISHING if you're satisfied.",
        showSolveWithSonnet: false,
      };
    }
    if (kind === "declined") {
      return {
        kind,
        title: "AI review rejected",
        message:
          "AI-REVIEW declined this change past the retry limit — it was NOT approved, and there is no merged PR. Read the decline comments below for the specific issue, then send back to IMPLEMENTING to fix it (or override to PUBLISHING if you disagree). It can't be marked DONE — there's nothing merged.",
        showSolveWithSonnet: false,
      };
    }
    if (kind === "question") {
      const esc = parseEscalation(task);
      const origin = esc?.origin_stage ?? "the stage";
      const opts = esc?.options?.length ? `\n\nOptions: ${esc.options.join(" | ")}` : "";
      const ev = esc?.evidence ? `\n\nEvidence: ${esc.evidence}` : "";
      return {
        kind,
        title: "Needs your decision",
        message:
          `The fleet couldn't resolve a judgment call and paused.${esc?.question ? `\n\n${esc.question}` : ""}${opts}${ev}\n\nComment your decision, then send the task back to ${origin}.`,
        showSolveWithSonnet: false,
      };
    }
    return {
      kind,
      title: "Merge conflict",
      message:
        "Resolve the conflict in GitHub then Retry PUBLISHING, or Solve with Sonnet, or send back to IMPLEMENTING for a redo.",
      showSolveWithSonnet: !config.publishing_solve_conflicts,
    };
  }, [
    task,
    task.status,
    task.pending_review_kind,
    task.delivery_url,
    task.draft_pr,
    project?.has_repo,
    project?.merge_to_main,
    project?.draft_pr,
    config.publishing_solve_conflicts,
  ]);

  // True if Sonnet is actively solving — survives navigation by checking
  // claimed_until from DB, not just ephemeral local state.
  const isSolving =
    resolving ||
    (task.status === "NEEDS_REVIEW" &&
      task.pending_review_kind === "conflict" &&
      task.claimed_until !== null &&
      task.claimed_until > Math.floor(Date.now() / 1000));

  const resolveConflict = useCallback(async () => {
    if (isSolving || busy) return;
    setResolving(true);
    try {
      const next = await api.resolveConflict(task.id);
      setTask(next);
      toast.push({
        variant: "success",
        title: "Sonnet is resolving the conflict",
      });
    } catch (err) {
      setResolving(false);
      toast.push({
        variant: "danger",
        title: "Could not start resolver",
        description: (err as Error).message,
      });
    }
  }, [busy, isSolving, task.id, toast]);

  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-2 mb-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-text-2 hover:text-text"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Board
          </Link>
        </div>

        <div className="lg:grid lg:grid-cols-[1fr_300px] lg:gap-6">
          <div className="min-w-0 space-y-4">
            <header className="rounded-md border border-border bg-surface p-5">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-text-2">{task.id}</span>
                  <PriorityBadge priority={task.priority} />
                  <StatusBadge status={task.status} />
                  {project ? (
                    <Link
                      href={`/projects/${project.id}`}
                      className="text-xs font-mono text-text-2 hover:text-text underline-offset-2 hover:underline"
                    >
                      {project.slug}
                    </Link>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <DeleteTaskButton taskId={task.id} taskName={task.name} />
                  <Link href={`/tasks/${task.id}/edit`}>
                    <Button variant="primary" size="default">
                      Edit
                    </Button>
                  </Link>
                </div>
              </div>
              <h1 className="text-xl font-bold">{task.name}</h1>
              {task.description ? (
                <p className="text-sm text-text-2 mt-2 whitespace-pre-wrap">
                  {task.description}
                </p>
              ) : null}
              {task.delivery_url ? (
                task.delivery_url.startsWith("local:") ? (
                  <span
                    className="mt-3 inline-flex items-center gap-1.5 text-sm font-mono break-all"
                    title="Local merge — no PR/remote. Merged to the project's main on this machine."
                  >
                    <GitMerge className="h-3.5 w-3.5 shrink-0 text-purple-500" />
                    <span className="text-purple-500">
                      local merge · {task.delivery_url.slice("local:".length)}
                    </span>
                  </span>
                ) : task.delivery_url.startsWith("branch:") ? (
                  <span
                    className="mt-3 inline-flex items-center gap-1.5 text-sm font-mono break-all"
                    title="PR creation disabled — branch pushed to origin. Open a PR or merge it manually."
                  >
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <span className="text-amber-500">
                      branch · {task.delivery_url.slice("branch:".length)} · no PR
                    </span>
                  </span>
                ) : (
                  <a
                    href={task.delivery_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 text-sm font-mono hover:underline underline-offset-2 break-all"
                  >
                    {task.status === "DONE" ? (
                      <GitMerge className="h-3.5 w-3.5 shrink-0 text-purple-500" />
                    ) : task.pending_review_kind === "conflict" ? (
                      <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-danger" />
                    ) : (
                      <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-success" />
                    )}
                    <span className={
                      task.status === "DONE" ? "text-purple-500" :
                      task.pending_review_kind === "conflict" ? "text-danger" :
                      "text-info"
                    }>
                      {task.delivery_url}
                    </span>
                  </a>
                )
              ) : null}
            </header>

            <Tabs defaultValue="plan">
        <TabsList>
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="acceptance">Acceptance</TabsTrigger>
          <TabsTrigger value="comments">
            Comments{" "}
            <span className="ml-1 text-xs text-text-2 font-mono">
              {sortedComments.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="meta">Meta</TabsTrigger>
        </TabsList>

        <TabsContent value="plan" className="pt-4 space-y-4">
          {task.plan_summary.trim() ? (
            <section aria-labelledby="plan-summary-label">
              <h3
                id="plan-summary-label"
                className="text-xs uppercase tracking-wide text-text-2 mb-2"
              >
                Summary
              </h3>
              <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed border border-border rounded-sm p-4 bg-surface">
                {task.plan_summary}
              </pre>
            </section>
          ) : null}

          {task.plan ? (
            <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed border border-border rounded-sm p-4 bg-surface">
              {task.plan}
            </pre>
          ) : (
            <p className="text-sm text-text-2">No plan yet.</p>
          )}
        </TabsContent>

        <TabsContent value="checklist" className="pt-4">
          {task.checklist ? (
            <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed border border-border rounded-sm p-4 bg-surface">
              {task.checklist}
            </pre>
          ) : (
            <p className="text-sm text-text-2">No checklist yet.</p>
          )}
        </TabsContent>

        <TabsContent value="acceptance" className="pt-4">
          {task.acceptance ? (
            <>
              <p className="text-xs text-text-2 mb-2">
                Definition of done — what VERIFYING runs the change against.
              </p>
              <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed border border-border rounded-sm p-4 bg-surface">
                {task.acceptance}
              </pre>
            </>
          ) : (
            <p className="text-sm text-text-2">
              No acceptance set. {task.skip_verify
                ? "Verification is skipped for this task."
                : "VERIFYING will fall back to the plan + checklist."}
            </p>
          )}
        </TabsContent>

        <TabsContent value="comments" className="pt-4 space-y-4">
          {sortedComments.length === 0 ? (
            <p className="text-sm text-text-2">No comments yet.</p>
          ) : (
            <ul className="space-y-3">
              {sortedComments.map((c) => (
                <li
                  key={c.id}
                  className="border border-border rounded-sm p-3 bg-surface"
                >
                  <div className="flex items-center gap-2 text-xs text-text-2 mb-1">
                    <span
                      className={
                        c.author === "human"
                          ? "text-human font-medium"
                          : "text-ai font-medium"
                      }
                    >
                      {c.author}
                    </span>
                    <span className="font-mono">{c.stage}</span>
                    <span className="font-mono">
                      {new Date(c.at * 1000).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{c.text}</p>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submitComment} className="space-y-2">
            <Textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={`Add a comment as human in stage ${task.status}…`}
              rows={3}
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !commentText.trim()}>
                Add comment
              </Button>
            </div>
          </form>
        </TabsContent>

        <TabsContent value="usage" className="pt-4">
          <UsageTab taskId={task.id} />
        </TabsContent>

        <TabsContent value="meta" className="pt-4 text-sm">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 font-mono">
            <MetaRow k="mode" v={task.mode} />
            <MetaRow k="branch" v={task.branch ?? "—"} />
            <MetaRow k="worktree_path" v={task.worktree_path ?? "—"} />
            <MetaRow k="workspace_path" v={task.workspace_path ?? "—"} />
            <MetaRow
              k="affected_paths"
              v={task.affected_paths.join(", ") || "—"}
            />
            <MetaRow k="depends_on" v={task.depends_on.join(", ") || "—"} />
            <MetaRow k="conflicts_with" v={task.conflicts_with.join(", ") || "—"} />
            <MetaRow k="skip_plan" v={String(task.skip_plan)} />
            <MetaRow k="skip_plan_review" v={String(task.skip_plan_review)} />
            <MetaRow k="skip_ai_review" v={String(task.skip_ai_review)} />
            <MetaRow k="skip_verify" v={String(task.skip_verify)} />
            <MetaRow k="auto_publish" v={String(task.auto_publish)} />
            <MetaRow k="created_at" v={fmt(task.created_at)} />
            <MetaRow k="started_at" v={fmt(task.started_at)} />
            <MetaRow k="stage_entered_at" v={fmt(task.stage_entered_at)} />
            <MetaRow k="updated_at" v={fmt(task.updated_at)} />
            <MetaRow k="ended_at" v={fmt(task.ended_at)} />
            <MetaRow k="claimed_by" v={task.claimed_by ?? "—"} />
            <MetaRow k="claimed_until" v={fmt(task.claimed_until)} />
          </dl>
            </TabsContent>
            </Tabs>
          </div>

          <aside className="mt-4 lg:mt-0 order-first lg:order-last">
            <div className="lg:sticky lg:top-4 space-y-3">
              {reviewContext ? (
                <div
                  className={cn(
                    "rounded-md border p-4",
                    reviewContext.kind === "conflict"
                      ? "border-danger/40 bg-danger/5"
                      : "border-warning/40 bg-warning/5",
                  )}
                >
                  <h3
                    className={cn(
                      "text-xs font-semibold uppercase tracking-wide mb-1.5",
                      reviewContext.kind === "conflict"
                        ? "text-danger"
                        : "text-warning",
                    )}
                  >
                    {reviewContext.title}
                  </h3>
                  <p className="text-xs text-text-2 whitespace-pre-line">{reviewContext.message}</p>
                  {task.delivery_url ? (
                    task.delivery_url.startsWith("local:") ? (
                      <span
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-mono text-purple-500"
                        title={`Local merge to main · ${task.delivery_url.slice("local:".length)}`}
                      >
                        <GitMerge className="h-3 w-3 shrink-0" />
                        Local merge · {task.delivery_url.slice("local:".length)}
                      </span>
                    ) : task.delivery_url.startsWith("branch:") ? (
                      <span
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-mono text-amber-500"
                        title={`PR creation disabled — branch pushed to origin. Open a PR or merge it manually · ${task.delivery_url.slice("branch:".length)}`}
                      >
                        <GitBranch className="h-3 w-3 shrink-0" />
                        branch · {task.delivery_url.slice("branch:".length)} · no PR
                      </span>
                    ) : (
                      <a
                        href={task.delivery_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                          "mt-2 inline-flex items-center gap-1.5 text-xs font-mono hover:underline underline-offset-2",
                          reviewContext.kind === "conflict" ? "text-danger" : "text-success",
                        )}
                      >
                        <GitPullRequest className="h-3 w-3 shrink-0" />
                        Open PR
                      </a>
                    )
                  ) : null}
                  {reviewContext.showSolveWithSonnet ? (
                    <button
                      type="button"
                      onClick={resolveConflict}
                      disabled={isSolving || busy}
                      className={cn(
                        "mt-3 w-full flex items-center gap-2.5 h-9 px-3 rounded-md border text-sm font-medium",
                        "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                      )}
                    >
                      {isSolving ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4 shrink-0" />
                      )}
                      <span className="flex-1 text-left">
                        {isSolving ? "Sonnet is solving…" : "Solve with Sonnet"}
                      </span>
                    </button>
                  ) : null}
                </div>
              ) : null}

              {allowed.length > 0 ? (
                <div className="rounded-md border border-border bg-surface p-4">
                  <h3 className="text-xs font-semibold text-text-2 uppercase tracking-wide mb-3">
                    Actions
                  </h3>
                  <div className="space-y-1.5">
                    {[...allowed]
                      .map((s) => ({
                        s,
                        intent: intentFor(
                          task.status,
                          s,
                          task.pending_review_kind,
                        ),
                      }))
                      .sort(
                        (a, b) =>
                          INTENT_ORDER[a.intent] - INTENT_ORDER[b.intent],
                      )
                      .map(({ s, intent }) => {
                        const Icon =
                          task.status === "CANCELED"
                            ? RotateCcw
                            : INTENT_STYLE[intent].icon;
                        // Approving a PR-less (create_pr off) deliverable merges
                        // straight to main + pushes origin — confirm the unguarded
                        // write before it happens.
                        const needsBranchConfirm =
                          intent === "approve" &&
                          task.pending_review_kind === "deliverable" &&
                          (task.delivery_url?.startsWith("branch:") ?? false) &&
                          project?.merge_to_main !== false;
                        // Cancel on a repo project with a PR or branch → show
                        // the close-PR / delete-branch modal.
                        const hasPrUrl = !!(
                          task.delivery_url?.startsWith("http")
                        );
                        const hasBranch = !!task.branch;
                        const needsCancelDialog =
                          intent === "cancel" &&
                          project?.has_repo &&
                          (hasPrUrl || hasBranch);
                        const btn = (
                          <button
                            key={s}
                            type="button"
                            onClick={
                              needsBranchConfirm || needsCancelDialog
                                ? undefined
                                : () => transitionTo(s)
                            }
                            disabled={busy || isSolving}
                            className={cn(
                              "w-full flex items-center gap-2.5 h-9 px-3 rounded-md border text-sm font-medium transition-colors",
                              "disabled:opacity-50 disabled:cursor-not-allowed",
                              "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                              INTENT_STYLE[intent].cls,
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="flex-1 text-left whitespace-nowrap truncate">
                              {labelFor(
                                task.status,
                                s,
                                intent,
                                task.pending_review_kind,
                              )}
                            </span>
                          </button>
                        );
                        if (needsBranchConfirm) {
                          return (
                            <ConfirmDialog
                              key={s}
                              title="Merge to main — no PR"
                              description={`PR creation is off for this project. Approving merges branch ${task.branch} into ${project?.default_branch ?? "main"} and pushes to origin, then marks the task DONE.`}
                              confirmLabel="Merge & finish"
                              busyLabel="Merging…"
                              trigger={btn}
                              onConfirm={() => transitionTo(s)}
                            />
                          );
                        }
                        if (needsCancelDialog) {
                          return (
                            <div key={s}>
                              <button
                                type="button"
                                onClick={() => setCancelDialogOpen(true)}
                                disabled={busy || isSolving}
                                className={cn(
                                  "w-full flex items-center gap-2.5 h-9 px-3 rounded-md border text-sm font-medium transition-colors",
                                  "disabled:opacity-50 disabled:cursor-not-allowed",
                                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                                  INTENT_STYLE[intent].cls,
                                )}
                              >
                                <Icon className="h-4 w-4 shrink-0" />
                                <span className="flex-1 text-left whitespace-nowrap truncate">
                                  {labelFor(task.status, s, intent, task.pending_review_kind)}
                                </span>
                              </button>
                              <CancelTaskDialog
                                open={cancelDialogOpen}
                                onOpenChange={setCancelDialogOpen}
                                hasPrUrl={hasPrUrl}
                                hasBranch={hasBranch}
                                prUrl={hasPrUrl ? task.delivery_url ?? undefined : undefined}
                                branchName={task.branch ?? undefined}
                                onConfirm={(opts) => transitionTo(s, opts)}
                              />
                            </div>
                          );
                        }
                        return btn;
                      })}
                  </div>
                </div>
              ) : null}

              <div className="rounded-md border border-border bg-surface p-4">
                <h3 className="text-xs font-semibold text-text-2 uppercase tracking-wide mb-2">
                  Quick info
                </h3>
                <dl className="space-y-1.5 text-xs">
                  <QuickRow k="mode" v={task.mode} mono />
                  <QuickRow k="branch" v={task.branch ?? "—"} mono />
                  <QuickRow
                    k="created"
                    v={fmtShort(task.created_at)}
                  />
                  <QuickRow
                    k="updated"
                    v={fmtShort(task.updated_at)}
                  />
                  <QuickRow
                    k="stage entered"
                    v={fmtShort(task.stage_entered_at)}
                  />
                  {task.ended_at ? (
                    <QuickRow k="ended" v={fmtShort(task.ended_at)} />
                  ) : null}
                  {task.claimed_by ? (
                    <QuickRow k="claimed by" v={task.claimed_by} mono />
                  ) : null}
                  <DeclineCycleRow
                    current={declineCycles}
                    max={config.max_ai_decline_cycles}
                  />
                </dl>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function DeleteTaskButton({
  taskId,
  taskName,
}: {
  taskId: string;
  taskName: string;
}) {
  const router = useRouter();
  const toast = useToast();

  return (
    <ConfirmDialog
      title="Delete task?"
      description={`This will permanently remove "${taskName}" and all its comments. This action cannot be undone.`}
      confirmLabel="Delete"
      busyLabel="Deleting…"
      confirmVariant="danger"
      trigger={
        <Button variant="ghost" size="default" className="text-danger hover:bg-danger/10">
          Delete
        </Button>
      }
      onConfirm={async () => {
        try {
          await api.deleteTask(taskId);
          toast.push({ variant: "success", title: "Task deleted" });
          router.push("/");
        } catch (err) {
          toast.push({
            variant: "danger",
            title: "Delete failed",
            description: (err as Error).message,
          });
          throw err;
        }
      }}
    />
  );
}

function QuickRow({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-text-2 shrink-0">{k}</dt>
      <dd className={cn("text-text text-right break-all", mono && "font-mono")}>
        {v}
      </dd>
    </div>
  );
}

function DeclineCycleRow({ current, max }: { current: number; max: number }) {
  const danger = current >= max;
  const warn = !danger && current >= max - 1;
  const cls = danger ? "text-danger" : warn ? "text-warning" : "text-text-3";
  return (
    <div
      className="flex items-baseline justify-between gap-3"
      title={`AI auto-actions since your last comment: ${current}. The brake trips at ${max} (forces NEEDS_REVIEW). It can read higher than the threshold — later AI actions (e.g. conflict-resolve retries) keep counting until you comment, which resets it.`}
    >
      <dt className="text-text-2 shrink-0">AI actions</dt>
      <dd className={cn("text-right font-mono", cls)}>
        {current} <span className="text-text-3">· brake {max}</span>
      </dd>
    </div>
  );
}

function fmtShort(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function MetaRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border py-1">
      <dt className="text-xs text-text-2 min-w-[8rem]">{k}</dt>
      <dd className="text-xs text-text break-all">{v}</dd>
    </div>
  );
}

function fmt(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

const STAGE_LABEL: Record<string, string> = {
  planning: "PLANNING",
  implementing: "IMPLEMENTING",
  ai_review: "AI-REVIEW",
  verify: "VERIFYING",
  publishing: "PUBLISHING",
};

function fmtDuration(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function UsageTab({ taskId }: { taskId: string }) {
  const [stages, setStages] = useState<StageUsageRollup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch once the tab mounts (TabsContent only renders the active tab's body).
  useEffect(() => {
    let cancelled = false;
    api
      .getTaskUsage(taskId)
      .then((s) => {
        if (!cancelled) setStages(s);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (error) {
    return <p className="text-sm text-danger">Could not load usage: {error}</p>;
  }
  if (stages === null) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-text-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading usage…
      </p>
    );
  }
  if (stages.length === 0) {
    return (
      <p className="text-sm text-text-2">
        No tokens metered yet — usage appears once stages start running.
      </p>
    );
  }

  const totals = stages.reduce(
    (acc, s) => ({
      runs: acc.runs + s.runs,
      total_tokens: acc.total_tokens + s.total_tokens,
      cost_usd: acc.cost_usd + s.cost_usd,
      num_turns: acc.num_turns + s.num_turns,
      duration_ms: acc.duration_ms + s.duration_ms,
    }),
    { runs: 0, total_tokens: 0, cost_usd: 0, num_turns: 0, duration_ms: 0 },
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border border-border rounded-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-text-2 text-left">
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium text-right">Runs</th>
            <th className="px-3 py-2 font-medium text-right">Tokens</th>
            <th className="px-3 py-2 font-medium text-right">Cost</th>
            <th className="px-3 py-2 font-medium text-right">Turns</th>
            <th className="px-3 py-2 font-medium text-right">Duration</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {stages.map((s) => {
            const isVerify = s.stage === "verify";
            return (
              <tr
                key={s.stage}
                className={cn(
                  "border-b border-border last:border-b-0",
                  isVerify && "bg-warning/5",
                )}
              >
                <td
                  className={cn(
                    "px-3 py-2",
                    isVerify ? "text-warning font-medium" : "text-text",
                  )}
                >
                  {STAGE_LABEL[s.stage] ?? s.stage}
                </td>
                <td className="px-3 py-2 text-right text-text-2">{s.runs}</td>
                <td
                  className="px-3 py-2 text-right text-text"
                  title={`${s.total_tokens.toLocaleString()} tokens`}
                >
                  {formatTokens(s.total_tokens)}
                </td>
                <td className="px-3 py-2 text-right text-text-2">
                  ${s.cost_usd.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right text-text-2">
                  {s.num_turns}
                </td>
                <td className="px-3 py-2 text-right text-text-2">
                  {fmtDuration(s.duration_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-strong font-mono font-medium">
            <td className="px-3 py-2 text-text">Total</td>
            <td className="px-3 py-2 text-right text-text-2">{totals.runs}</td>
            <td
              className="px-3 py-2 text-right text-text"
              title={`${totals.total_tokens.toLocaleString()} tokens`}
            >
              {formatTokens(totals.total_tokens)}
            </td>
            <td className="px-3 py-2 text-right text-text">
              ${totals.cost_usd.toFixed(2)}
            </td>
            <td className="px-3 py-2 text-right text-text-2">
              {totals.num_turns}
            </td>
            <td className="px-3 py-2 text-right text-text-2">
              {fmtDuration(totals.duration_ms)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
