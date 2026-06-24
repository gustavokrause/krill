import Link from "next/link";
import { ProjectForm } from "@/components/project/project-form";

export default function NewProjectPage() {
  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <div className="mb-4">
        <Link
          href="/projects"
          className="text-sm text-text-2 hover:text-text underline-offset-2 hover:underline"
        >
          ← Projects
        </Link>
        <h1 className="text-xl font-bold mt-2">New project</h1>
      </div>
      <ProjectForm kind="create" presentation="page" />
    </main>
  );
}
