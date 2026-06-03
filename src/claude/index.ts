import type { ClaudeRunner } from "./runner";
import { RealClaudeRunner } from "./runner";
import { StubClaudeRunner } from "./stub-runner";

let active: ClaudeRunner =
  process.env.CLAUDE_RUNNER === "real"
    ? new RealClaudeRunner()
    : new StubClaudeRunner();

export function getRunner(): ClaudeRunner {
  return active;
}

export function setRunner(runner: ClaudeRunner): void {
  active = runner;
}

export { RealClaudeRunner, StubClaudeRunner };
export type { ClaudeRunner };
