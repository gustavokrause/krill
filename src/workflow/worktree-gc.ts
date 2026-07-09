import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  WORKTREE_RETAINED_STATUSES,
  globalConfig,
  projects,
  tasks,
} from "@/db/schema";
import { removeWorktree } from "@/git";
import { resolveProjectPath } from "@/lib/api/util";

/**
 * Sweep orphaned worktrees. Layout is {worktrees_root}/{project_slug}/{task_id};
 * normal removal happens in applyTransitionSideEffects on a clean transition,
 * so anything left behind belongs to a task that crashed mid-stage, was
 * deleted, or finished while its process died. Those directories leak disk
 * and can collide with a later ensureWorkspace for a re-used task id.
 *
 * A worktree is retained only while its task id exists AND its status is in
 * WORKTREE_RETAINED_STATUSES. Everything else under the root is removed via
 * `git worktree remove --force` against the owning project repo.
 */
export async function runWorktreeGc(): Promise<number> {
  const cfg = db
    .select({ root: globalConfig.worktrees_root })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  const root = resolveProjectPath(cfg?.root ?? "~/.ai-worktrees/");
  if (!existsSync(root)) return 0;

  const retained = new Set(
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, WORKTREE_RETAINED_STATUSES))
      .all()
      .map((t) => t.id),
  );

  let removed = 0;
  for (const slugEntry of readdirSync(root, { withFileTypes: true })) {
    if (!slugEntry.isDirectory()) continue;
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.slug, slugEntry.name))
      .get();
    // Unknown slug → a deleted project's leftovers; without the owning repo we
    // can't `git worktree remove` safely, so leave it for a manual sweep.
    if (!project?.has_repo) continue;

    const slugDir = join(root, slugEntry.name);
    for (const wtEntry of readdirSync(slugDir, { withFileTypes: true })) {
      if (!wtEntry.isDirectory()) continue;
      if (retained.has(wtEntry.name)) continue;
      const wtPath = join(slugDir, wtEntry.name);
      try {
        await removeWorktree({
          projectFolder: project.folder_path,
          worktreePath: wtPath,
        });
        removed++;
        console.warn(
          `[worktree-gc] removed orphaned worktree ${wtPath} (task ${wtEntry.name} inactive or gone)`,
        );
      } catch (err) {
        // A long-dead orphan may no longer be a REGISTERED worktree (git
        // metadata pruned) — `git worktree remove` refuses with "not a working
        // tree". It's then just a leftover directory under our own root with
        // an inactive/gone task: delete it directly.
        try {
          rmSync(wtPath, { recursive: true, force: true });
          removed++;
          console.warn(
            `[worktree-gc] rm'd unregistered orphan dir ${wtPath} (git refused: ${String(err).slice(0, 120)})`,
          );
        } catch (rmErr) {
          console.warn(`[worktree-gc] failed to remove ${wtPath}:`, rmErr);
        }
      }
    }
  }
  return removed;
}
