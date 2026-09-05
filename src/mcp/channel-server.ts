import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelMcpRuntime } from "./channel-server-runtime.js";

/**
 * MCP stdio server assembly for OpenClaw channel conversations.
 *
 * This module wires config, the Gateway bridge, protocol notifications, and
 * registered tools into a lifecycle that callers can either embed or serve.
 */
type OpenClawMcpServeOptions = NonNullable<Parameters<typeof createChannelMcpRuntime>[0]>;

/** Serve the channel MCP server over stdio until transport or process shutdown. */
export async function serveOpenClawChannelMcp(opts: OpenClawMcpServeOptions = {}): Promise<void> {
  const { server, start, close } = await createChannelMcpRuntime(opts);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let closePromise: Promise<void> | undefined;
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
    // Assign before cleanup starts so SDK transport-close reentry observes the same owner promise.
    closePromise = Promise.resolve().then(close);
    void closePromise.then(resolveClosed, resolveClosed);
  };

  transport["onclose"] = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await start();
    await closed;
    await closePromise;
  } finally {
    shutdown();
    await closed;
    await closePromise;
  }
}
