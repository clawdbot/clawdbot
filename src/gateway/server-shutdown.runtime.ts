export async function prepareGatewayShutdownRuntime() {
  const [
    { createGatewayCloseHandler, drainActiveSessionsForShutdown, runGatewayClosePrelude },
    { runGlobalGatewayStopSafely },
    { flushPendingSessionsChangedEvents },
    { closeMcpLoopbackServer },
    { stopTaskRegistryMaintenance },
    { markRestartAbortedMainSessions },
    { disposeAllBundleLspRuntimes },
    { drainRetainedOpenAiEmbeddingProviders },
    { stopGmailWatcher },
    { disposeAllCodeModeRuns },
    { closeProviderTransportDispatcherPool },
    { clearActivePluginRegistry, prepareActivePluginRegistryShutdown },
  ] = await Promise.all([
    import("./server-close.runtime.js"),
    import("../plugins/hook-runner-global.js"),
    import("./server-methods/session-change-event.js"),
    import("./mcp-http.js"),
    import("../tasks/task-registry.maintenance.js"),
    import("../agents/main-session-recovery/main-session-restart-recovery.js"),
    import("../agents/agent-bundle-lsp-runtime.js"),
    import("./embeddings-http.js"),
    import("../hooks/gmail-watcher.js"),
    import("../agents/code-mode-state.js"),
    import("../agents/provider-transport-dispatcher-pool.js"),
    import("../plugins/runtime.js"),
  ]);
  await prepareActivePluginRegistryShutdown();

  return {
    createGatewayCloseHandler,
    drainActiveSessionsForShutdown,
    runGatewayClosePrelude,
    runGlobalGatewayStopSafely,
    flushPendingSessionsChangedEvents,
    closeMcpLoopbackServer,
    stopTaskRegistryMaintenance,
    markRestartAbortedMainSessions,
    disposeAllBundleLspRuntimes,
    drainRetainedOpenAiEmbeddingProviders,
    stopGmailWatcher,
    disposeAllCodeModeRuns,
    closeProviderTransportDispatcherPool,
    clearActivePluginRegistry: () =>
      clearActivePluginRegistry({ preservePersistentSessionState: true }),
  };
}

export type GatewayShutdownRuntime = Awaited<ReturnType<typeof prepareGatewayShutdownRuntime>>;
