import { spawn } from "node:child_process";
import type { Project, Task } from "@/db/schema";
import { MODEL_BY_STAGE, type ModelStage } from "./model-map";
import { RateLimitError, TimeoutError } from "./errors";
import { generateMcpConfig } from "./mcp-config";

export type RunnerInput = {
  stage: ModelStage;
  task: Task;
  project: Project;
  prompt: string;
  mcpToken: string;
  baseUrl: string;
  cwd: string;
  timeoutMs: number;
};

export type RunnerOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export interface ClaudeRunner {
  run(input: RunnerInput): Promise<RunnerOutput>;
}

const RATE_LIMIT_SIGNALS = [
  /rate.?limit/i,
  /quota.*exceed/i,
  /429/,
  /overloaded/i,
];

export class RealClaudeRunner implements ClaudeRunner {
  constructor(private claudeBin: string = "claude") {}

  async run(input: RunnerInput): Promise<RunnerOutput> {
    const cfg = generateMcpConfig({
      baseUrl: input.baseUrl,
      token: input.mcpToken,
    });

    return await new Promise((resolveP, rejectP) => {
      const child = spawn(
        this.claudeBin,
        [
          "--model",
          MODEL_BY_STAGE[input.stage],
          "--mcp-config",
          cfg.path,
          // Restrict the session to our per-invocation MCP config; ignore any
          // user-scoped servers in ~/.claude.json.
          "--strict-mcp-config",
          "--print",
          "--input-format",
          "text",
          "--output-format",
          "text",
          // Headless cron has no TTY for approval prompts. Permission gating
          // happens upstream (stage handlers, MCP stage-auth, brake) and the
          // subprocess is sandboxed to worktree_path / workspace_path via the
          // spawn cwd option below.
          "--dangerously-skip-permissions",
        ],
        {
          cwd: input.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b.toString()));
      child.stderr.on("data", (b) => (stderr += b.toString()));

      const killer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, input.timeoutMs);

      child.on("error", (err) => {
        clearTimeout(killer);
        cfg.cleanup();
        rejectP(err);
      });

      child.on("exit", (code, signal) => {
        clearTimeout(killer);
        cfg.cleanup();
        const exitCode = code ?? -1;

        console.log(
          `[claude:${input.stage}:${input.task.id}] exit=${exitCode} signal=${signal} stdout=${stdout.length}B stderr=${stderr.length}B`,
        );
        if (stdout) console.log(`[claude:${input.stage}:${input.task.id}] stdout:\n${stdout.slice(0, 2000)}`);
        if (stderr) console.log(`[claude:${input.stage}:${input.task.id}] stderr:\n${stderr.slice(0, 2000)}`);

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          rejectP(new TimeoutError(`claude killed by ${signal} after timeout`));
          return;
        }

        if (exitCode !== 0) {
          if (RATE_LIMIT_SIGNALS.some((re) => re.test(stderr))) {
            rejectP(new RateLimitError(stderr.trim().slice(0, 500)));
            return;
          }
          rejectP(
            new Error(
              `claude exited ${exitCode}: ${stderr.trim().slice(0, 500)}`,
            ),
          );
          return;
        }

        resolveP({ stdout, stderr, exitCode });
      });

      child.stdin.write(input.prompt);
      child.stdin.end();
    });
  }
}
