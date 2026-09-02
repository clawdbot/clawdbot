import { Server } from "@modelcontextprotocol/server";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
// MCP stdio server exposes OpenClaw tools over the MCP stdio transport.
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { VERSION } from "../version.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

export function createToolsMcpServer(params: { name: string; tools: AnyAgentTool[] }): Server {
  const handlers = createPluginToolsMcpHandlers(params.tools);
  const server = new Server(
    { name: params.name, version: VERSION },
    { capabilities: { tools: {} } },
  );

  // v2 result types carry the spec wire shape (_meta/index signature); the
  // handler factories produce plain JSON-RPC payloads, so assert at the seam.
  server.setRequestHandler("tools/list", async () => {
    // SAFETY: handler factory returns spec-compatible JSON-RPC payload.
    return (await handlers.listTools()) as ListToolsResult;
  });
  server.setRequestHandler("tools/call", async (request, ctx) => {
    // SAFETY: handler factory returns spec-compatible JSON-RPC payload.
    return (await handlers.callTool(request.params, ctx.mcpReq.signal)) as CallToolResult;
  });

  return server;
}

export async function connectToolsMcpServerToStdio(
  server: Server,
  options: { onShutdown?: () => Promise<void> | void } = {},
): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only.
  routeLogsToStderr();

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  let resolveShutdown: (() => void) | undefined;
  const shutdownComplete = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
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
    void (async () => {
      let shutdownError: unknown;
      try {
        await server.close();
      } catch (error) {
        shutdownError = error;
      }
      try {
        await options.onShutdown?.();
      } catch (error) {
        shutdownError ??= error;
      } finally {
        resolveShutdown?.();
      }
      if (shutdownError) {
        process.stderr.write(`MCP stdio shutdown failed: ${formatErrorMessage(shutdownError)}\n`);
      }
    })();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
  if (options.onShutdown) {
    await shutdownComplete;
  }
}
