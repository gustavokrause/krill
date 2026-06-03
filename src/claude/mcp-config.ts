import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Generate a per-invocation MCP config JSON pointing the Claude CLI at our
 * HTTP MCP endpoint with a task-scoped auth token. Returns the temp file
 * path; caller must call cleanup() after the subprocess exits.
 */
export function generateMcpConfig(opts: {
  baseUrl: string;
  token: string;
}): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ai-mcp-"));
  const path = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      "ai-workflow": {
        type: "http",
        url: `${opts.baseUrl.replace(/\/$/, "")}/api/mcp`,
        headers: {
          Authorization: `Bearer ${opts.token}`,
        },
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
