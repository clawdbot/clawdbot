import type { MatrixClient } from "../sdk.js";
import { isMatrixTerminalSyncState, type MatrixSyncState } from "../sync-state.js";
import type { MatrixMonitorStatusController } from "./status.js";

function formatSyncLifecycleError(state: MatrixSyncState, error?: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  const message = typeof error === "string" && error.trim() ? error.trim() : undefined;
  if (state === "STOPPED") {
    return new Error(message ?? "Matrix sync stopped unexpectedly");
  }
  if (state === "ERROR") {
    return new Error(message ?? "Matrix sync entered ERROR unexpectedly");
  }
  return new Error(message ?? `Matrix sync entered ${state} unexpectedly`);
}

export function createMatrixMonitorSyncLifecycle(params: {
  client: MatrixClient;
  statusController: MatrixMonitorStatusController;
  isStopping?: () => boolean;
}) {
  let fatalError: Error | null = null;
  let resolveFatalWait: (() => void) | null = null;
  let rejectFatalWait: ((error: Error) => void) | null = null;

  const settleFatal = (error: Error) => {
    if (fatalError) {
      return;
    }
    fatalError = error;
    rejectFatalWait?.(error);
    resolveFatalWait = null;
    rejectFatalWait = null;
  };

  const onSyncState = (state: MatrixSyncState, _prevState: string | null, error?: unknown) => {
    if (isMatrixTerminalSyncState(state) && !params.isStopping?.()) {
      const fatalError = formatSyncLifecycleError(state, error);
      params.statusController.noteUnexpectedError(fatalError);
      settleFatal(fatalError);
      return;
    }
    // Fatal sync failures are sticky for telemetry; later SDK state churn during
    // cleanup or reconnect should not overwrite the first recorded error.
    if (fatalError) {
      return;
    }
    // Operator-initiated shutdown can still emit transient sync states before
    // the final STOPPED. Ignore that churn so intentional stops do not look
    // like runtime failures.
    if (params.isStopping?.() && !isMatrixTerminalSyncState(state)) {
      return;
    }
    params.statusController.noteSyncState(state, error);
  };

  const onUnexpectedError = (error: Error) => {
    if (params.isStopping?.()) {
      return;
    }
    params.statusController.noteUnexpectedError(error);
    settleFatal(error);
  };

  params.client.on("sync.state", onSyncState);
  params.client.on("sync.unexpected_error", onUnexpectedError);

  return {
    async waitForFatalStop(): Promise<void> {
      if (fatalError) {
        throw fatalError;
      }
      if (resolveFatalWait || rejectFatalWait) {
        throw new Error("Matrix fatal-stop wait already in progress");
      }
      await new Promise<void>((resolve, reject) => {
        resolveFatalWait = resolve;
        rejectFatalWait = (error) => reject(error);
      });
    },
    dispose() {
      resolveFatalWait?.();
      resolveFatalWait = null;
      rejectFatalWait = null;
      params.client.off("sync.state", onSyncState);
      params.client.off("sync.unexpected_error", onUnexpectedError);
    },
  };
}
