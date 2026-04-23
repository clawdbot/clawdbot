/**
 * Standalone MCP server for selected built-in OpenClaw tools.
 *
 * Run via: node --import tsx src/mcp/openclaw-tools-serve.ts
 * Or: bun src/mcp/openclaw-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { VERSION } from "../version.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

export function resolveOpenClawToolsForMcp(): AnyAgentTool[] {
  return [createCronTool()];
}

export function createOpenClawToolsMcpServer(
  params: {
    tools?: AnyAgentTool[];
  } = {},
): Server {
  const tools = params.tools ?? resolveOpenClawToolsForMcp();
  const handlers = createPluginToolsMcpHandlers(tools);

  const server = new Server(
    { name: "openclaw-tools", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, handlers.listTools);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await handlers.callTool(request.params);
  });

  return server;
}

export async function serveOpenClawToolsMcp(): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only.
  routeLogsToStderr();

  const server = createOpenClawToolsMcpServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void server.close();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveOpenClawToolsMcp().catch((err) => {
    process.stderr.write(`openclaw-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
