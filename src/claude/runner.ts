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

// Token usage for a single claude spawn, parsed from the `--output-format json`
// result envelope. Cache field names map from the CLI's *_input_tokens keys.
export type RunUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
};

export type RunnerOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  // Set when the run produced a parseable json envelope; undefined on auth
  // prompt / crash / non-json. Callers record it but never depend on it.
  usage?: RunUsage;
};

/**
 * Parse the `claude --output-format json` result envelope for token usage.
 * Returns undefined on any failure (non-json stdout from an auth prompt, a
 * crash, or a format change) — the caller must treat usage as best-effort.
 */
export function parseRunUsage(stdout: string): RunUsage | undefined {
  try {
    const env = JSON.parse(stdout);
    const u = env?.usage;
    if (!u || typeof u !== "object") return undefined;
    return {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cost_usd: env.total_cost_usd ?? 0,
      num_turns: env.num_turns ?? 0,
      duration_ms: env.duration_ms ?? 0,
    };
  } catch {
    return undefined;
  }
}

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
          // json envelope carries the token `usage` + `total_cost_usd` we meter.
          // krill never parsed stdout (transitions ride MCP tool calls), so this
          // is a safe swap; classifyBlock still scans the raw json string below.
          "--output-format",
          "json",
          // Keep the machine-specific bits (cwd, git status, env) OUT of the
          // cached system prompt so the static prefix stays prompt-cache-hittable
          // across spawns. Pure cache efficiency — no behavior change. Each spawn
          // re-reads the full context every turn, so a cheaper cached prefix is a
          // direct cut to the cache_read that dominates our token count.
          "--exclude-dynamic-system-prompt-sections",
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
              // Strip the OAuth URL + markdown noise: the link is single-use and
              // process-scoped (dies with this worker), so showing it only misleads.
              // Keep the surrounding guidance text (names which MCP needs auth).
              detail: (stdout || stderr)
                .replace(/https?:\/\/\S+/g, "")
                .replace(/\*\*/g, "")
                .replace(/\n{3,}/g, "\n\n")
                .trim()
                .slice(0, 500),
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

        resolveP({ stdout, stderr, exitCode, usage: parseRunUsage(stdout) });
      });

      // Fill prompt placeholders with the real run values. The prompts carry
      // {task_id}/{cwd}/{project_*} literally; stages survive an unfilled prompt
      // only because they call task_context() regardless, but a stricter prompt
      // (the escalation resolver) refuses to act on a literal `{task_id}`. Fill
      // them centrally so every prompt sees real values.
      const filled = input.prompt
        .replaceAll("{task_id}", input.task.id)
        .replaceAll("{cwd}", input.cwd)
        .replaceAll("{project_name}", input.project.name)
        .replaceAll("{project_slug}", input.project.slug);
      child.stdin.write(filled);
      child.stdin.end();
    });
  }
}
