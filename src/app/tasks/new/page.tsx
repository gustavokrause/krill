import Link from "next/link";
import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { TaskForm } from "@/components/task/task-form";

export const dynamic = "force-dynamic";

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: projectSlug } = await searchParams;
  const all = db.select().from(projects).orderBy(asc(projects.slug)).all();
  const defaultProjectId = projectSlug
    ? all.find((p) => p.slug === projectSlug)?.id
    : undefined;
  if (all.length === 0) {
    return (
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        <h1 className="text-xl font-bold mb-2">New task</h1>
        <div className="border border-dashed border-border rounded-sm p-8 text-center">
          <p className="text-sm font-medium">No projects yet</p>
          <p className="text-xs text-text-2 mt-1">
            Register a project before creating tasks.
          </p>
          <Link
            href="/projects/new"
            className="inline-block mt-3 h-9 px-4 rounded bg-primary text-white text-sm font-medium leading-9"
          >
            New project
          </Link>
        </div>
      </main>
    );
  }
  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <Link
        href="/"
        className="text-sm text-text-2 hover:text-text underline-offset-2 hover:underline"
      >
        ← Board
      </Link>
      <h1 className="text-xl font-bold mt-2 mb-4">New task</h1>
      <TaskForm kind="create" projects={all} defaultProjectId={defaultProjectId} />
    </main>
  );
}
