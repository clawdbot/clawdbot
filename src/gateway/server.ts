/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server.impl` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server.impl.js";

function emitStartupTrace(name: string, durationMs: number, totalMs: number): void {
  if (!process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) {
    return;
  }
  process.stderr.write(
    `[gateway] startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
  );
}

async function loadServerImpl() {
  const startupStartedAt = performance.now();
  const before = performance.now();
  try {
    return await import("./server.impl.js");
  } finally {
    const now = performance.now();
    emitStartupTrace("gateway.server-impl-import", now - before, now - startupStartedAt);
  }
}

/** Starts the gateway server after lazily loading the full server implementation. */
export async function startGatewayServer(
  ...args: Parameters<typeof import("./server.impl.js").startGatewayServer>
): ReturnType<typeof import("./server.impl.js").startGatewayServer> {
  const mod = await loadServerImpl();
  return await mod.startGatewayServer(...args);
}

/** Clears the server implementation's model-catalog cache between tests. */
export async function resetModelCatalogCacheForTest(): Promise<void> {
  const mod = await loadServerImpl();
  await mod.resetModelCatalogCacheForTest();
}
