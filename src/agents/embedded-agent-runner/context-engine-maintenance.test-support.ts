import "./context-engine-maintenance.js";

type DeferredTurnMaintenanceProcessLike = Pick<NodeJS.Process, "on" | "off"> &
  Partial<Pick<NodeJS.Process, "listenerCount" | "kill" | "pid">> & {
    [key: symbol]: unknown;
  };

type ContextEngineMaintenanceTestApi = {
  createDeferredTurnMaintenanceAbortSignal(params?: {
    processLike?: DeferredTurnMaintenanceProcessLike;
  }): {
    abortSignal?: AbortSignal;
    dispose: () => void;
  };
  resetDeferredTurnMaintenanceStateForTest(): void;
};

function getTestApi(): ContextEngineMaintenanceTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineMaintenanceTestApi")
  ] as ContextEngineMaintenanceTestApi;
}

export function createDeferredTurnMaintenanceAbortSignal(params?: {
  processLike?: DeferredTurnMaintenanceProcessLike;
}): {
  abortSignal?: AbortSignal;
  dispose: () => void;
} {
  return getTestApi().createDeferredTurnMaintenanceAbortSignal(params);
}

export function resetDeferredTurnMaintenanceStateForTest(): void {
  getTestApi().resetDeferredTurnMaintenanceStateForTest();
}
