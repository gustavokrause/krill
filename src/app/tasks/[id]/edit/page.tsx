import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, tasks } from "@/db/schema";
import { TaskForm } from "@/components/task/task-form";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function EditTaskPage({ params }: Ctx) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) notFound();
  const all = db.select().from(projects).orderBy(asc(projects.slug)).all();

  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <Link
        href={`/tasks/${task.id}`}
        className="text-sm text-text-2 hover:text-text underline-offset-2 hover:underline"
      >
        ← {task.id}
      </Link>
      <h1 className="text-xl font-bold mt-2 mb-4">Edit task</h1>
      <TaskForm kind="edit" task={task} projects={all} />
    </main>
  );
}
