/**
 * Process-scoped abort-signal wiring for deferred context-engine turn
 * maintenance. A single set of SIGINT/SIGTERM handlers fans termination out to
 * every in-flight maintenance run so a waiting shutdown never leaks listeners.
 */

// Shared per-process store of live abort controllers plus their signal
// handlers; keyed off the process object so tests can inject a fake process.
export const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceAbortState",
);

type DeferredTurnMaintenanceSignal = "SIGINT" | "SIGTERM";
export type DeferredTurnMaintenanceProcessLike = Pick<NodeJS.Process, "on" | "off"> &
  Partial<Pick<NodeJS.Process, "listenerCount" | "kill" | "pid">> & {
    [DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY]?: DeferredTurnMaintenanceAbortState;
  };
type DeferredTurnMaintenanceAbortState = {
  controllers: Set<AbortController>;
  cleanupHandlers: Map<DeferredTurnMaintenanceSignal, () => void>;
};

export function unregisterDeferredTurnMaintenanceAbortSignalHandlers(
  processLike: DeferredTurnMaintenanceProcessLike,
  state: DeferredTurnMaintenanceAbortState,
): void {
  for (const [signal, handler] of state.cleanupHandlers) {
    processLike.off(signal, handler);
  }
  state.cleanupHandlers.clear();
}

export function createDeferredTurnMaintenanceAbortSignal(params?: {
  processLike?: DeferredTurnMaintenanceProcessLike;
}): {
  abortSignal: AbortSignal;
  abort: (reason: Error) => void;
  dispose: () => void;
} {
  const processLike = (params?.processLike ?? process) as DeferredTurnMaintenanceProcessLike;
  const state = (processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY] ??= {
    controllers: new Set<AbortController>(),
    cleanupHandlers: new Map<DeferredTurnMaintenanceSignal, () => void>(),
  });
  const handleTerminationSignal = (signalName: DeferredTurnMaintenanceSignal) => {
    const shouldReraise = processLike.listenerCount?.(signalName) === 1;
    for (const activeController of state.controllers) {
      if (!activeController.signal.aborted) {
        activeController.abort(
          new Error(`received ${signalName} while waiting for deferred maintenance`),
        );
      }
    }
    state.controllers.clear();
    unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
    if (shouldReraise && typeof processLike.kill === "function") {
      try {
        processLike.kill(processLike.pid ?? process.pid, signalName);
      } catch {
        // Ignore shutdown-path failures.
      }
    }
  };
  if (state.cleanupHandlers.size === 0) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => handleTerminationSignal(signal);
      state.cleanupHandlers.set(signal, handler);
      processLike.on(signal, handler);
    }
  }

  const controller = new AbortController();
  state.controllers.add(controller);
  return {
    abortSignal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    dispose: () => {
      state.controllers.delete(controller);
      if (state.controllers.size === 0) {
        unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
      }
    },
  };
}
