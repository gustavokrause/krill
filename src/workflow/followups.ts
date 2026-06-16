import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { followups, projects } from "@/db/schema";
import { now } from "./types";

export type OpenFollowup = {
  id: string;
  task_id: string | null;
  project_slug: string;
  project_name: string;
  title: string;
  description: string;
  created_at: number;
};

/** Open follow-ups joined with their project slug/name (for whale to ingest). */
export function listOpenFollowups(): OpenFollowup[] {
  return db
    .select({
      id: followups.id,
      task_id: followups.task_id,
      project_slug: projects.slug,
      project_name: projects.name,
      title: followups.title,
      description: followups.description,
      created_at: followups.created_at,
    })
    .from(followups)
    .innerJoin(projects, eq(followups.project_id, projects.id))
    .where(eq(followups.status, "open"))
    .orderBy(desc(followups.created_at))
    .all();
}

export function consumeFollowup(id: string): boolean {
  const r = db
    .update(followups)
    .set({ status: "consumed", consumed_at: now() })
    .where(eq(followups.id, id))
    .run();
  return r.changes > 0;
}
