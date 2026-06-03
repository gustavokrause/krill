import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { ProjectForm } from "@/components/project/project-form";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function ProjectEditPage({ params }: Ctx) {
  const { id } = await params;
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) notFound();

  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <div className="mb-4">
        <Link
          href="/projects"
          className="text-sm text-text-2 hover:text-text underline-offset-2 hover:underline"
        >
          ← Projects
        </Link>
        <h1 className="text-xl font-bold mt-2">
          {project.slug} — {project.name}
        </h1>
      </div>
      <ProjectForm kind="edit" project={project} />
    </main>
  );
}
