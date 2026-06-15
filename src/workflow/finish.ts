import type { Project, Task } from "@/db/schema";
import { mergePr, localMergeToMain, pushDefaultBranch } from "@/git";
import { resolveProjectPath } from "@/lib/api/util";
import { resolvePublishPolicy } from "./publish-policy";

/**
 * Merge a delivered task into the default branch. Three delivery shapes:
 *   https://… (PR)     -> squash-merge the PR
 *   local:<branch>     -> local merge, no push (remote-less, A1)
 *   branch:<branch>    -> PR-less direct-to-main (create_pr off): local merge,
 *                         then push origin/<default> when push_remote is on
 * Shared by manual deliverable→DONE approval (transition) and A2 auto-finish
 * (publishing). No-op for non-repo / missing delivery.
 */
export async function finishMerge(task: Task, project: Project): Promise<void> {
  if (!project.has_repo || !task.delivery_url) return;
  if (/^https?:\/\//.test(task.delivery_url)) {
    await mergePr(project.folder_path, task.delivery_url, "squash");
  } else if (task.delivery_url.startsWith("local:") && task.branch) {
    const policy = await resolvePublishPolicy(project);
    if (policy.mergeToMain) {
      await localMergeToMain(
        resolveProjectPath(project.folder_path),
        task.branch,
        project.default_branch,
      );
    }
  } else if (task.delivery_url.startsWith("branch:") && task.branch) {
    const policy = await resolvePublishPolicy(project);
    if (policy.mergeToMain) {
      const repoPath = resolveProjectPath(project.folder_path);
      await localMergeToMain(repoPath, task.branch, project.default_branch);
      if (policy.pushRemote) {
        await pushDefaultBranch(repoPath, project.default_branch);
      }
    }
  }
}

/**
 * A2 gate: may this task skip the deliverable review and auto-finish? Both keys
 * required — the task carries auto_publish AND the project opted in. (The risk
 * envelope — low-risk, non-self-edit — is enforced upstream by whale, which only
 * sets auto_publish for eligible tasks.)
 */
export function autoFinishEligible(task: Task, project: Project): boolean {
  return !!task.auto_publish && !!project.allow_auto_finish;
}
