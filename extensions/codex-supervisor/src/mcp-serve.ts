/**
 * Standalone MCP server for OpenClaw Codex supervision.
 *
 * Run via: node --import tsx extensions/codex-supervisor/src/mcp-serve.ts
 */
import { pathToFileURL } from "node:url";
import { serveCodexSupervisorMcp } from "./mcp-server.js";

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveCodexSupervisorMcp().catch((err: unknown) => {
    process.stderr.write(`codex-supervisor-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
