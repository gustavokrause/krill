import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { ProjectForm } from "@/components/project/project-form";
import { FormModal } from "@/components/ui/form-modal";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function EditProjectModal({ params }: Ctx) {
  const { id } = await params;
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) notFound();

  return (
    <FormModal title={`${project.slug} — ${project.name}`}>
      <ProjectForm kind="edit" project={project} />
    </FormModal>
  );
}
