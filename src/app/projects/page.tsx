import { asc, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { PARALLEL_SLOT_STATUSES, projects, tasks } from "@/db/schema";
import { ProjectList } from "@/components/project/project-list";
import { getProjectTokenTotals } from "@/lib/usage-rollups";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const all = db.select().from(projects).orderBy(asc(projects.slug)).all();

  const counts = db
    .select({
      project_id: tasks.project_id,
      n: sql<number>`count(*)`,
    })
    .from(tasks)
    .where(inArray(tasks.status, PARALLEL_SLOT_STATUSES))
    .groupBy(tasks.project_id)
    .all();

  const wipMap = new Map<string, number>(
    counts.map((r) => [r.project_id, Number(r.n)]),
  );
  const tokenMap = getProjectTokenTotals(all.map((p) => p.id));

  const entries = all.map((p) => ({
    project: p,
    activeCount: wipMap.get(p.id) ?? 0,
    tokensUsed: tokenMap.get(p.id) ?? 0,
  }));

  return <ProjectList initial={entries} />;
}
