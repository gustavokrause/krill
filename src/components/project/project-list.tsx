"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Coins, FolderGit2, GitBranch, Layers, Pause, Play } from "lucide-react";
import type { Project } from "@/db/schema";
import { useEventSource } from "@/lib/client/use-event-source";
import { formatTokens } from "@/lib/client/format";
import { Button } from "@/components/ui/button";

function ProjectCard({
  p,
  activeCount,
  tokensUsed,
}: {
  p: Project;
  activeCount: number;
  tokensUsed: number;
}) {
  const slotsFull = activeCount >= p.max_parallel_tasks;
  return (
    <Link
      href={`/projects/${p.id}`}
      className="group relative flex flex-col rounded-md border border-border bg-surface p-4 hover:border-border-strong transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md bg-primary/10 text-primary">
          <FolderGit2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text truncate">
            {p.name}
          </h2>
          <p className="text-xs font-mono text-text-2 truncate">{p.slug}</p>
        </div>
        <StatusPill paused={p.paused} />
      </div>

      <p
        className="mt-3 text-xs font-mono text-text-3 truncate"
        title={p.folder_path}
      >
        {p.folder_path}
      </p>

      <div className="mt-3 pt-3 border-t border-border flex items-center gap-4 text-xs text-text-2">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5" />
          {p.has_repo ? (
            <span className="text-success font-medium">repo</span>
          ) : (
            <span>no repo</span>
          )}
        </span>
        <span
          className="inline-flex items-center gap-1.5"
          title={`Active tasks consuming a slot (PLANNING/IMPLEMENTING/AI-REVIEW/PUBLISHING) vs project's max_parallel_tasks. Snapshot at page load.`}
        >
          <Layers className="h-3.5 w-3.5" />
          <span className={`font-mono ${slotsFull ? "text-warning" : ""}`}>
            {activeCount}/{p.max_parallel_tasks}
          </span>
          <span>slots</span>
        </span>
        <span
          className="inline-flex items-center gap-1.5"
          title={`Total tokens metered across all tasks in this project: ${tokensUsed.toLocaleString()}`}
        >
          <Coins className="h-3.5 w-3.5" />
          <span className="font-mono">{formatTokens(tokensUsed)}</span>
          <span>tok</span>
        </span>
        <span className="ml-auto text-text-3 group-hover:text-text transition-colors">
          Edit →
        </span>
      </div>
    </Link>
  );
}

function StatusPill({ paused }: { paused: boolean }) {
  if (paused) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 text-warning text-[10px] font-medium px-2 py-0.5">
        <Pause className="h-3 w-3" />
        Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 text-success text-[10px] font-medium px-2 py-0.5">
      <Play className="h-3 w-3" />
      Live
    </span>
  );
}

export type ProjectListEntry = {
  project: Project;
  activeCount: number;
  tokensUsed: number;
};

export function ProjectList({ initial }: { initial: ProjectListEntry[] }) {
  const [entries, setEntries] = useState<ProjectListEntry[]>(initial);

  // useState seeds once on mount; re-sync when the server prop changes so
  // router.refresh() (fired after create/edit) surfaces new projects.
  useEffect(() => {
    setEntries(initial);
  }, [initial]);

  const upsert = useCallback((p: Project) => {
    setEntries((prev) => {
      const i = prev.findIndex((x) => x.project.id === p.id);
      if (i === -1)
        return [...prev, { project: p, activeCount: 0, tokensUsed: 0 }];
      const copy = prev.slice();
      copy[i] = { ...copy[i], project: p };
      return copy;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.project.id !== id));
  }, []);

  useEventSource({
    "project.updated": (e) => e.type === "project.updated" && upsert(e.project),
    "project.deleted": (e) =>
      e.type === "project.deleted" && remove(e.projectId),
  });

  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center gap-2 mb-4">
          <div>
            <h1 className="text-xl font-bold">Projects</h1>
            <p className="text-xs text-text-2 mt-0.5">
              {entries.length} {entries.length === 1 ? "project" : "projects"}
            </p>
          </div>
          <div className="flex-1" />
          <Link href="/projects/new">
            <Button>New project</Button>
          </Link>
        </div>

        {entries.length === 0 ? (
          <div className="border border-dashed border-border rounded-md p-8 text-center">
            <p className="text-sm font-medium">No projects</p>
            <p className="text-xs text-text-2 mt-1">
              Register the first project to start creating tasks.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {entries.map((e) => (
              <ProjectCard
                key={e.project.id}
                p={e.project}
                activeCount={e.activeCount}
                tokensUsed={e.tokensUsed}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
