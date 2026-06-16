import type { Project, Task } from "@/db/schema";
import { hasRemote } from "@/git";
import { resolveProjectPath } from "@/lib/api/util";

export type PublishPolicy = {
  createPr: boolean;
  pushRemote: boolean;
  mergeToMain: boolean;
  draftPr: boolean;
};

/**
 * Resolve the effective publish policy (A1). Precedence, highest first:
 *   task override → project setting → auto-detect.
 * Auto-detect (a NULL that reaches the bottom) keys off whether the repo has a
 * remote: remote present → PR flow (create_pr / push_remote on); no remote →
 * local merge (both off). merge_to_main defaults on; draft_pr defaults off.
 */
export async function resolvePublishPolicy(
  project: Project,
  task?: Task,
): Promise<PublishPolicy> {
  const remote = await hasRemote(resolveProjectPath(project.folder_path));
  const createPr = task?.create_pr ?? project.create_pr ?? remote;
  const pushRemote = task?.push_remote ?? project.push_remote ?? remote;
  const draftRaw = task?.draft_pr ?? project.draft_pr ?? false;
  return {
    createPr,
    pushRemote,
    mergeToMain: task?.merge_to_main ?? project.merge_to_main ?? true,
    // Draft only means anything in the PR flow (a PR is created + pushed).
    // Outside it (local merge / direct-to-main) there's no PR to draft.
    draftPr: draftRaw && createPr && pushRemote,
  };
}
