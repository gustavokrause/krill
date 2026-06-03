import { spawn } from "node:child_process";
import { GhCliError } from "./errors";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Run a command, capture stdio. Does NOT throw on non-zero — caller
 * decides. Use throwIfFailed() for the common case.
 */
export function execCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? -1 }),
    );
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

export function throwIfFailed(res: ExecResult, msg: string): void {
  if (res.exitCode !== 0) {
    throw new GhCliError(
      `${msg} (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 500)}`,
      res.stderr,
      res.exitCode,
    );
  }
}
