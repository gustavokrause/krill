import { spawn } from "node:child_process";
import type { Project, Task } from "@/db/schema";
import { MODEL_BY_STAGE, type ModelStage } from "./model-map";
import { BlockedError, RateLimitError, TimeoutError, classifyBlock } from "./errors";
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
          // User MCP servers (e.g. Supabase) load alongside our task server so
          // krill can make real changes — parity with whale. Set KRILL_STRICT_MCP=1
          // to isolate to only our per-invocation config (ignore ~/.claude.json).
          ...(process.env.KRILL_STRICT_MCP === "1" ? ["--strict-mcp-config"] : []),
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

        // 143 = 128+SIGTERM, 137 = 128+SIGKILL: process caught the signal and
        // exited itself, so Node reports a numeric code with signal=null.
        if (signal === "SIGTERM" || signal === "SIGKILL" || exitCode === 143 || exitCode === 137) {
          rejectP(new TimeoutError(`claude killed by signal after timeout (exit ${exitCode ?? signal})`));
          return;
        }

        // Interactive block: an unauthenticated MCP / logged-out CLI answered with
        // an OAuth URL or login prompt (often exit 0). Pause + file a blocker.
        const block = classifyBlock(`${stdout}\n${stderr}`);
        if (block) {
          rejectP(
            new BlockedError({
              kind: block.kind,
              summary:
                block.kind === "cli_login"
                  ? "The Claude CLI isn't logged in"
                  : "An MCP server needs authentication",
              detail: (stdout || stderr).slice(0, 600),
              actionUrl: block.actionUrl,
              taskId: input.task.id,
              stage: input.stage,
            }),
          );
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
