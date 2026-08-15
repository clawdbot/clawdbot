/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server-start` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server-public.js";

async function emitStartupTrace(name: string, durationMs: number, totalMs: number): Promise<void> {
  if (!process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) {
    return;
  }
  const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
  const message = `[gateway] startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`;
  process.stderr.write(`${formatConsoleDiagnosticLine({ level: "info", message })}\n`);
}

async function loadServerStart() {
  const startupStartedAt = performance.now();
  const before = performance.now();
  try {
    return await import("./server-start.js");
  } finally {
    const now = performance.now();
    await emitStartupTrace("gateway.server-start-import", now - before, now - startupStartedAt);
  }
}

/** Starts the gateway server after lazily loading the full server implementation. */
export async function startGatewayServer(
  ...args: Parameters<typeof import("./server-start.js").startGatewayServerCore>
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  const mod = await loadServerStart();
  return await mod.startGatewayServerCore(...args);
}

/** Clears prepared model-catalog generations between tests. */
export async function resetPreparedModelCatalogForTest(): Promise<void> {
  const mod = await loadServerStart();
  await mod.resetPreparedModelCatalogForTestCore();
}
