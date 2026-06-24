import { ProjectForm } from "@/components/project/project-form";
import { FormModal } from "@/components/ui/form-modal";

export default function NewProjectModal() {
  return (
    <FormModal title="New project">
      <ProjectForm kind="create" presentation="modal" />
    </FormModal>
  );
}
