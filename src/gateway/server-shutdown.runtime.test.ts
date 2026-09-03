import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  loaded: [] as string[],
  close: vi.fn(),
  flushSessionChanges: vi.fn(),
  stopPlugins: vi.fn(),
  clearPluginRegistry: vi.fn(),
  preparePluginRegistryShutdown: vi.fn(async () => undefined),
}));

vi.mock("./server-close.runtime.js", () => {
  state.loaded.push("server-close");
  return {
    createGatewayCloseHandler: state.close,
    drainActiveSessionsForShutdown: vi.fn(),
    runGatewayClosePrelude: vi.fn(),
  };
});
vi.mock("../plugins/hook-runner-global.js", () => {
  state.loaded.push("plugin-hooks");
  return { runGlobalGatewayStopSafely: state.stopPlugins };
});
vi.mock("./server-methods/session-change-event.js", () => {
  state.loaded.push("session-change-events");
  return { flushPendingSessionsChangedEvents: state.flushSessionChanges };
});
vi.mock("./mcp-http.js", () => {
  state.loaded.push("mcp-http");
  return { closeMcpLoopbackServer: vi.fn() };
});
vi.mock("../tasks/task-registry.maintenance.js", () => {
  state.loaded.push("task-maintenance");
  return { stopTaskRegistryMaintenance: vi.fn() };
});
vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => {
  state.loaded.push("restart-recovery");
  return { markRestartAbortedMainSessions: vi.fn() };
});
vi.mock("../agents/agent-bundle-lsp-runtime.js", () => {
  state.loaded.push("bundle-lsp");
  return { disposeAllBundleLspRuntimes: vi.fn() };
});
vi.mock("./embeddings-http.js", () => {
  state.loaded.push("embeddings");
  return { drainRetainedOpenAiEmbeddingProviders: vi.fn() };
});
vi.mock("../hooks/gmail-watcher.js", () => {
  state.loaded.push("gmail-watcher");
  return { stopGmailWatcher: vi.fn() };
});
vi.mock("../agents/code-mode-state.js", () => {
  state.loaded.push("code-mode");
  return { disposeAllCodeModeRuns: vi.fn() };
});
vi.mock("../agents/provider-transport-dispatcher-pool.js", () => {
  state.loaded.push("provider-transports");
  return { closeProviderTransportDispatcherPool: vi.fn() };
});
vi.mock("../plugins/runtime.js", () => {
  state.loaded.push("plugin-runtime");
  return {
    clearActivePluginRegistry: state.clearPluginRegistry,
    prepareActivePluginRegistryShutdown: state.preparePluginRegistryShutdown,
  };
});

const { prepareGatewayShutdownRuntime } = await import("./server-shutdown.runtime.js");

describe("gateway shutdown runtime", () => {
  it("resolves every shutdown dependency during preparation", async () => {
    const runtime = await prepareGatewayShutdownRuntime();

    expect(state.loaded.toSorted()).toEqual(
      [
        "server-close",
        "plugin-hooks",
        "session-change-events",
        "mcp-http",
        "task-maintenance",
        "restart-recovery",
        "bundle-lsp",
        "embeddings",
        "gmail-watcher",
        "code-mode",
        "provider-transports",
        "plugin-runtime",
      ].toSorted(),
    );
    expect(runtime.createGatewayCloseHandler).toBe(state.close);
    expect(runtime.flushPendingSessionsChangedEvents).toBe(state.flushSessionChanges);
    expect(runtime.runGlobalGatewayStopSafely).toBe(state.stopPlugins);
    expect(runtime.clearActivePluginRegistry).toBe(state.clearPluginRegistry);
    expect(state.preparePluginRegistryShutdown).toHaveBeenCalledOnce();
  });
});
