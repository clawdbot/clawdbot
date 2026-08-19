import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { SyncApi, SyncState } from "matrix-js-sdk/lib/sync.js";
import type { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import type { MatrixSyncState } from "../sync-state.js";

const MATRIX_SYNC_QUIESCE_TIMEOUT_MS = 5_000;
const MATRIX_JS_SDK_SYNC_VERSION = "41.9.0";
const matrixJsSdkPackage = createRequire(import.meta.url)("matrix-js-sdk/package.json") as {
  version?: unknown;
};

function assertMatrixJsSdkSyncVersion(): void {
  const version = matrixJsSdkPackage.version;
  if (version !== MATRIX_JS_SDK_SYNC_VERSION) {
    throw new Error(
      `Matrix sync quiesce requires matrix-js-sdk ${MATRIX_JS_SDK_SYNC_VERSION}; found ${String(version)}`,
    );
  }
}

export async function quiesceMatrixClientSync(params: {
  client: MatrixJsClient;
  emitter: EventEmitter;
  markStopped: () => void;
  started: boolean;
  syncStore?: Pick<
    SqliteBackedMatrixSyncStore,
    "discardPendingSyncCursorPersistence" | "freezeSyncCursorPersistence"
  >;
}): Promise<void> {
  await params.syncStore?.freezeSyncCursorPersistence();
  try {
    assertMatrixJsSdkSyncVersion();
  } catch (error) {
    params.syncStore?.discardPendingSyncCursorPersistence();
    throw error;
  }

  // 41.9.0: stop protected classic sync here; public stopClient also stops crypto.
  const syncApi = (params.client as MatrixJsClient & { syncApi?: unknown }).syncApi;
  if (syncApi === undefined && !params.started) {
    return;
  }
  if (!(syncApi instanceof SyncApi)) {
    params.syncStore?.discardPendingSyncCursorPersistence();
    throw new Error(
      syncApi === undefined
        ? "Matrix sync quiesce requires the classic matrix-js-sdk SyncApi, but none is active"
        : "Matrix sync quiesce rejected a sliding or unknown matrix-js-sdk sync implementation",
    );
  }
  if (syncApi.getSyncState() === SyncState.Stopped) {
    params.markStopped();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.emitter.off("sync.state", onSyncState);
      if (error) {
        reject(error);
      } else {
        params.markStopped();
        resolve();
      }
    };
    const onSyncState = (state: MatrixSyncState) => {
      if (state === "STOPPED") {
        settle();
      }
    };
    const timeout = setTimeout(() => {
      params.syncStore?.discardPendingSyncCursorPersistence();
      settle(new Error(`Matrix classic sync did not reach STOPPED within 5000ms`));
    }, MATRIX_SYNC_QUIESCE_TIMEOUT_MS);
    timeout.unref?.();

    params.emitter.on("sync.state", onSyncState);
    try {
      syncApi.stop();
    } catch (error) {
      params.syncStore?.discardPendingSyncCursorPersistence();
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
