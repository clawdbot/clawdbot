// MCP stdio server exposes OpenClaw tools over the MCP stdio transport.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import {
  PluginRegistryResourceScope,
  withPluginRegistryResourceScope,
} from "../plugins/registry-resources.js";
import { VERSION } from "../version.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

class ToolsMcpServer extends Server {
  readonly #resources: PluginRegistryResourceScope;
  readonly #pending = new Set<Promise<unknown>>();
  #closing = false;
  #drained: Promise<void> | undefined;

  override onclose = () => {
    void this.#drain().catch((error: unknown) =>
      this.onerror?.(toErrorObject(error, "MCP tool resource disposal failed")),
    );
  };

  constructor(params: {
    name: string;
    tools: AnyAgentTool[];
    resources?: PluginRegistryResourceScope;
  }) {
    super({ name: params.name, version: VERSION }, { capabilities: { tools: {} } });
    this.#resources = params.resources ?? new PluginRegistryResourceScope();
    const handlers = createPluginToolsMcpHandlers(params.tools);
    this.setRequestHandler(ListToolsRequestSchema, handlers.listTools);
    this.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (this.#closing) {
        throw new Error("MCP tool server is closing");
      }
      const execution = Promise.resolve().then(() =>
        withPluginRegistryResourceScope(this.#resources, () =>
          handlers.callTool(request.params, extra.signal),
        ),
      );
      this.#pending.add(execution);
      try {
        return await execution;
      } finally {
        this.#pending.delete(execution);
      }
    });
  }

  #drain(): Promise<void> {
    this.#closing = true;
    return (this.#drained ??= (async () => {
      // SDK transport close only aborts handlers; plugins may still be using SQLite.
      // Keep their exact registration resources until admitted work actually settles.
      await Promise.allSettled(this.#pending);
      this.#resources.release();
      await this.#resources.waitForDisposals();
    })());
  }

  override async close(): Promise<void> {
    this.#closing = true;
    try {
      await super.close();
    } finally {
      await this.#drain();
    }
  }
}

export function createToolsMcpServer(params: {
  name: string;
  tools: AnyAgentTool[];
  resources?: PluginRegistryResourceScope;
}): Server {
  return new ToolsMcpServer(params);
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

  try {
    await server.connect(transport);
  } catch (error) {
    shutdown();
    await shutdownComplete;
    throw error;
  }
  await shutdownComplete;
}
