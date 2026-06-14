import type { Project } from "@/db/schema";
import { hasRemote } from "@/git";
import { resolveProjectPath } from "@/lib/api/util";

export type PublishPolicy = {
  createPr: boolean;
  pushRemote: boolean;
  mergeToMain: boolean;
};

/**
 * Resolve a project's publish policy (A1). Per-project columns override; NULL
 * falls back to auto-detection from whether the repo has a remote:
 *   remote present -> PR flow (create_pr / push_remote on)
 *   no remote      -> local merge (both off), merge_to_main still on
 */
export async function resolvePublishPolicy(
  project: Project,
): Promise<PublishPolicy> {
  const remote = await hasRemote(resolveProjectPath(project.folder_path));
  return {
    createPr: project.create_pr ?? remote,
    pushRemote: project.push_remote ?? remote,
    mergeToMain: project.merge_to_main ?? true,
  };
}
