import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, tasks } from "@/db/schema";
import { TaskForm } from "@/components/task/task-form";
import { FormModal } from "@/components/ui/form-modal";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function EditTaskModal({ params }: Ctx) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) notFound();
  const all = db.select().from(projects).orderBy(asc(projects.slug)).all();

  return (
    <FormModal title={`Edit ${task.id}`}>
      <TaskForm kind="edit" task={task} projects={all} presentation="modal" />
    </FormModal>
  );
}
