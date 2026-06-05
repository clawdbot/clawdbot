/**
 * Standalone MCP stdio server for exposing Codex Supervisor tools to trusted
 * MCP clients.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCodexSupervisorEndpoints } from "./config.js";
import {
  registerCodexSupervisorMcpTools,
  type CodexSupervisorMcpToolOptions,
} from "./mcp-tools.js";
import { CodexSupervisor } from "./supervisor.js";

const VERSION = "0.1.0";

function routeLogsToStderr(): void {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      process.stderr.write(`${args.map(String).join(" ")}\n`);
    };
  }
}

/** Options for creating or serving a Codex Supervisor MCP server. */
export type CodexSupervisorMcpServeOptions = {
  supervisor?: CodexSupervisor;
  toolOptions?: CodexSupervisorMcpToolOptions;
};

/**
 * Creates an MCP server and owns the supervisor instance unless one is supplied.
 */
export function createCodexSupervisorMcpServer(opts: CodexSupervisorMcpServeOptions = {}): {
  server: McpServer;
  supervisor: CodexSupervisor;
  close: () => Promise<void>;
} {
  const supervisor = opts.supervisor ?? new CodexSupervisor(loadCodexSupervisorEndpoints());
  const server = new McpServer({ name: "openclaw-codex-supervisor", version: VERSION });
  registerCodexSupervisorMcpTools(server, supervisor, opts.toolOptions);
  return {
    server,
    supervisor,
    close: async () => {
      await supervisor.close();
      await server.close();
    },
  };
}

/**
 * Serves Codex Supervisor tools over MCP stdio until transport or process
 * shutdown.
 */
export async function serveCodexSupervisorMcp(
  opts: CodexSupervisorMcpServeOptions = {},
): Promise<void> {
  routeLogsToStderr();
  const { server, close } = createCodexSupervisorMcpServer(opts);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    // The SDK exposes this callback slot but not a stable setter; clear it so
    // close() cannot recursively re-enter shutdown.
    transport["onclose"] = undefined;
    close().then(resolveClosed, resolveClosed);
  };

  transport["onclose"] = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await closed;
  } finally {
    shutdown();
    await closed;
  }
}
