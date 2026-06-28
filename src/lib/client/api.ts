import type {
  Comment,
  GlobalConfig,
  Project,
  Task,
  TaskStatus,
} from "@/db/schema";

export type StuckEntry = {
  taskId: string;
  stage: string;
  ageSec: number;
  maxSec: number;
};

// Per-stage token rollup returned by GET /api/tasks/:id/usage. Mirrors the
// server-side shape in @/lib/usage-rollups (re-declared here to keep the client
// bundle free of server-only imports, matching how other responses are typed).
export type StageUsageRollup = {
  stage: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
};

export type HealthSnapshot = {
  db: { path: string; size_bytes: number | null };
  automation_enabled: boolean;
  stage_enabled: Record<string, boolean>;
  backoff: Record<string, { attempts: number; nextAttemptAt: number } | undefined>;
  projects: { total: number; paused: number };
  tasks_by_status: Record<TaskStatus, number>;
  active_tasks: number;
  stuck: StuckEntry[];
  sse_listeners: number;
  pinned_claude_version: string | null;
  boot_id: string;
  active_claims: number;
  active_claim_ids: string[];
  tokens_today: number;
};

async function jsonFetch<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    const err = new Error(
      typeof detail === "object" && detail !== null && "error" in detail
        ? (detail as { error: { message?: string } }).error?.message ??
          "request failed"
        : `HTTP ${res.status}`,
    );
    (err as unknown as { detail?: unknown }).detail = detail;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listProjects: () =>
    jsonFetch<{ projects: Project[] }>("/api/projects").then((r) => r.projects),
  getProject: (id: string) =>
    jsonFetch<{ project: Project }>(`/api/projects/${id}`).then((r) => r.project),
  createProject: (body: Partial<Project>) =>
    jsonFetch<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.project),
  patchProject: (id: string, body: Partial<Project>) =>
    jsonFetch<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.project),
  deleteProject: (id: string) =>
    jsonFetch<void>(`/api/projects/${id}`, { method: "DELETE" }),
  detectRepo: (folder_path: string) =>
    jsonFetch<{ has_repo: boolean; default_branch: string | null }>(
      "/api/projects/detect-repo",
      { method: "POST", body: JSON.stringify({ folder_path }) },
    ),

  listTasks: (params?: { status?: TaskStatus; project_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.project_id) q.set("project_id", params.project_id);
    const qs = q.toString() ? `?${q}` : "";
    return jsonFetch<{ tasks: Task[] }>(`/api/tasks${qs}`).then((r) => r.tasks);
  },
  getTask: (id: string) =>
    jsonFetch<{ task: Task }>(`/api/tasks/${id}`).then((r) => r.task),
  createTask: (body: Record<string, unknown>) =>
    jsonFetch<{ task: Task }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.task),
  patchTask: (id: string, body: Record<string, unknown>) =>
    jsonFetch<{ task: Task }>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.task),
  transitionTask: (
    id: string,
    body: {
      to: TaskStatus;
      from?: TaskStatus;
      comment?: { author: "human" | "ai"; text: string };
      cancel_options?: { close_pr: boolean; delete_branch: boolean };
    },
  ) =>
    jsonFetch<{ task: Task }>(`/api/tasks/${id}/transition`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.task),
  resolveConflict: (id: string) =>
    jsonFetch<{ task: Task }>(`/api/tasks/${id}/resolve-conflict`, {
      method: "POST",
    }).then((r) => r.task),
  deleteTask: (id: string) =>
    jsonFetch<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  recoverTask: (id: string) =>
    jsonFetch<{ task: Task; recovered: boolean }>(
      `/api/tasks/${id}/recover`,
      { method: "POST" },
    ).then((r) => r.task),

  listComments: (taskId: string) =>
    jsonFetch<{ comments: Comment[] }>(`/api/tasks/${taskId}/comments`).then(
      (r) => r.comments,
    ),
  appendComment: (
    taskId: string,
    body: { author: "human" | "ai"; stage: TaskStatus; text: string },
  ) =>
    jsonFetch<{ comment: Comment }>(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.comment),

  getTaskUsage: (id: string) =>
    jsonFetch<{ stages: StageUsageRollup[] }>(
      `/api/tasks/${id}/usage`,
    ).then((r) => r.stages),

  getHealth: () => jsonFetch<HealthSnapshot>("/api/health"),

  getConfig: () =>
    jsonFetch<{ config: GlobalConfig }>("/api/config").then((r) => r.config),
  patchConfig: (body: Record<string, unknown>) =>
    jsonFetch<{ config: GlobalConfig }>("/api/config", {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.config),

  cleanupPreview: (window: string) =>
    jsonFetch<{ count: number; window: string }>(
      `/api/tasks/cleanup?window=${window}`,
    ),
  cleanupTerminals: (window: string) =>
    jsonFetch<{ deleted: number; window: string }>("/api/tasks/cleanup", {
      method: "POST",
      body: JSON.stringify({ window }),
    }),
};
