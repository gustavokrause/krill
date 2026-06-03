import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClaudeRunner, RunnerInput, RunnerOutput } from "./runner";
import { resolveToken } from "./mcp-auth";
import { TOOL_REGISTRY } from "./mcp-server";

/**
 * In-process runner used for spike + tests. Bypasses the Claude subprocess
 * and exercises the MCP tools directly so the state machine can be proven
 * end-to-end without an external CLI.
 */
export class StubClaudeRunner implements ClaudeRunner {
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const ctx = resolveToken(input.mcpToken);
    if (!ctx) {
      return { stdout: "", stderr: "stub: token expired", exitCode: 1 };
    }

    const log: string[] = [];
    const { task, project } = input;

    switch (input.stage) {
      case "planning": {
        if (!task.skip_plan) {
          TOOL_REGISTRY.task_set_plan(ctx, {
            plan: `# Plan for ${task.id}\n\n${task.description || task.name}\n\n## Approach\n- Stub-generated for spike.\n`,
          });
          TOOL_REGISTRY.task_set_checklist(ctx, {
            checklist: `[ ] Investigate\n[ ] Implement\n[ ] Verify\n`,
          });
        }
        const deliveryPath = project.has_repo
          ? `docs/tasks/${task.id}.md`
          : `docs/tasks/${task.id}.md`;
        TOOL_REGISTRY.task_set_affected_paths(ctx, { paths: [deliveryPath] });
        TOOL_REGISTRY.task_append_comment(ctx, {
          stage: "PLANNING",
          text: "stub planning complete",
        });
        log.push("planning: wrote plan, checklist, affected_paths");
        break;
      }
      case "implementing": {
        const root = task.worktree_path ?? task.workspace_path;
        if (!root) {
          return {
            stdout: "",
            stderr: "stub: missing worktree/workspace path",
            exitCode: 1,
          };
        }
        const refreshed: string[] = [];
        for (const rel of task.affected_paths.length > 0
          ? task.affected_paths
          : [`docs/tasks/${task.id}.md`]) {
          const abs = join(root, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(
            abs,
            `# ${task.name}\n\n${task.description}\n\nDelivered by stub runner.\n`,
          );
          refreshed.push(rel);
        }
        TOOL_REGISTRY.task_set_checklist(ctx, {
          checklist: `[x] Investigate\n[x] Implement\n[x] Verify\n`,
        });
        TOOL_REGISTRY.task_set_affected_paths(ctx, { paths: refreshed });
        TOOL_REGISTRY.task_append_comment(ctx, {
          stage: "IMPLEMENTING",
          text: "stub implementation complete",
        });
        log.push(`implementing: wrote ${refreshed.length} files`);
        break;
      }
      case "ai_review": {
        TOOL_REGISTRY.task_decide(ctx, {
          outcome: "approve",
          reason: "stub auto-approve",
        });
        log.push("ai_review: approved");
        break;
      }
      case "publishing": {
        // PUBLISHING handler does the file move / PR; stub no-ops.
        log.push("publishing: handler-driven, stub no-op");
        break;
      }
    }

    return {
      stdout: log.join("\n"),
      stderr: "",
      exitCode: 0,
    };
  }
}
