import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { comments, globalConfig, projects, tasks } from "@/db/schema";
import { TaskDetail } from "@/components/task/task-detail";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function TaskPage({ params }: Ctx) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) notFound();
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, task.project_id))
    .get();
  const cmts = db
    .select()
    .from(comments)
    .where(eq(comments.task_id, id))
    .orderBy(asc(comments.at))
    .all();
  const config = db
    .select()
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  if (!config) notFound();

  return (
    <TaskDetail
      initialTask={task}
      initialComments={cmts}
      project={project ?? null}
      initialConfig={config}
    />
  );
}
