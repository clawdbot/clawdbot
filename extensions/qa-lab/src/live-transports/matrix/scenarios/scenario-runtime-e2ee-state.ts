// QA Lab Matrix destructive E2EE state-loss helpers.
import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { loadMatrixQaE2eeRuntime } from "../substrate/e2ee-client.js";
import { requestMatrixJson } from "../substrate/request.js";
import type { MatrixQaCliRuntime } from "./scenario-runtime-e2ee-destructive-recovery.js";

async function findFilesByName(params: { filename: string; rootDir: string }): Promise<string[]> {
  const matches: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 10) {
      return;
    }
    let entries: Array<{
      isDirectory(): boolean;
      isFile(): boolean;
      name: string;
    }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === params.filename) {
        matches.push(entryPath);
      } else if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
      }
    }
  }
  await visit(params.rootDir, 0);
  return matches.toSorted();
}

async function findMatrixQaCliAccountRoot(params: {
  deviceId: string;
  runtime: Pick<MatrixQaCliRuntime, "stateDir">;
  userId: string;
}) {
  const storageMetadataRuntime = await loadMatrixQaE2eeRuntime();
  const sqlitePaths = await findFilesByName({
    filename: "openclaw.sqlite",
    rootDir: params.runtime.stateDir,
  });
  const legacyMetadataPaths = await findFilesByName({
    filename: "storage-meta.json",
    rootDir: params.runtime.stateDir,
  });
  // Current account metadata lives in account-local SQLite. Keep legacy JSON
  // discovery for older tagged fixtures without making it the canonical path.
  const accountRoots = new Set(
    sqlitePaths
      .filter((sqlitePath) => path.basename(path.dirname(sqlitePath)) === "state")
      .map((sqlitePath) => path.dirname(path.dirname(sqlitePath))),
  );
  for (const metadataPath of legacyMetadataPaths) {
    accountRoots.add(path.dirname(metadataPath));
  }
  for (const accountRoot of [...accountRoots].toSorted()) {
    let metadata: { deviceId?: unknown; userId?: unknown } | null = null;
    try {
      await access(path.join(accountRoot, "state", "openclaw.sqlite"));
      try {
        const store = createPluginStateSyncKeyedStoreForTests<unknown>(
          "matrix",
          storageMetadataRuntime.openMatrixStorageMetaStoreOptions(accountRoot),
        );
        metadata = storageMetadataRuntime.normalizeMatrixStorageMetadata(store.lookup("current"));
      } finally {
        resetPluginStateStoreForTests();
      }
    } catch {
      // Fall through to the legacy sidecar for pre-SQLite fixtures.
    }
    if (!metadata) {
      try {
        metadata = JSON.parse(
          await readFile(path.join(accountRoot, "storage-meta.json"), "utf8"),
        ) as {
          deviceId?: unknown;
          userId?: unknown;
        };
      } catch {
        continue;
      }
    }
    if (metadata.userId === params.userId && metadata.deviceId === params.deviceId) {
      return accountRoot;
    }
  }
  throw new Error(`Matrix CLI account storage root was not created for ${params.userId}`);
}

function readMatrixQaCliRecoveryKeyState(options: OpenKeyedStoreOptions): unknown {
  try {
    return createPluginStateSyncKeyedStoreForTests<unknown>("matrix", options).lookup("current");
  } finally {
    resetPluginStateStoreForTests();
  }
}

function writeMatrixQaCliRecoveryKeyState(params: {
  options: OpenKeyedStoreOptions;
  recoveryKeyState: unknown;
}): void {
  try {
    createPluginStateSyncKeyedStoreForTests<unknown>("matrix", params.options).register(
      "current",
      params.recoveryKeyState,
    );
  } finally {
    resetPluginStateStoreForTests();
  }
}

export async function mutateMatrixQaCliStateLoss(params: {
  deviceId: string;
  preserveRecoveryKey: boolean;
  runtime: Pick<MatrixQaCliRuntime, "stateDir">;
  userId: string;
}) {
  const accountRoot = await findMatrixQaCliAccountRoot(params);
  const matrixRuntime = await loadMatrixQaE2eeRuntime();
  const recoveryKeyStoreOptions = matrixRuntime.openMatrixRecoveryKeyStoreOptions(accountRoot);
  let recoveryKeyPreserved = false;
  let recoveryKeyState: unknown = null;
  if (params.preserveRecoveryKey) {
    recoveryKeyState = readMatrixQaCliRecoveryKeyState(recoveryKeyStoreOptions);
    if (!recoveryKeyState) {
      throw new Error("Matrix CLI recovery key state was not created");
    }
    recoveryKeyPreserved = true;
  }
  await rm(accountRoot, { force: true, recursive: true });
  if (recoveryKeyState) {
    await mkdir(accountRoot, { recursive: true });
    writeMatrixQaCliRecoveryKeyState({ options: recoveryKeyStoreOptions, recoveryKeyState });
  }
  return {
    accountRoot,
    recoveryKeyPreserved,
  };
}

export async function corruptMatrixQaCliIdbSnapshot(params: {
  deviceId: string;
  runtime: MatrixQaCliRuntime;
  userId: string;
}) {
  const accountRoot = await findMatrixQaCliAccountRoot(params);
  const matrixRuntime = await loadMatrixQaE2eeRuntime();
  try {
    createPluginStateSyncKeyedStoreForTests<unknown>(
      "matrix",
      matrixRuntime.openMatrixIdbSnapshotStoreOptions(accountRoot),
    ).register("current:meta", {
      kind: "meta",
      version: 1,
      generation: "corrupt",
      chunkCount: 1,
      digest: "corrupt",
      databaseCount: 1,
      persistedAt: new Date().toISOString(),
    });
  } finally {
    resetPluginStateStoreForTests();
  }
  return "matrix/idb-snapshot/current:meta";
}

export async function deleteMatrixQaServerRoomKeyBackup(params: {
  accessToken: string;
  baseUrl: string;
  version: string;
}) {
  const response = await requestMatrixJson<Record<string, never>>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: `/_matrix/client/v3/room_keys/version/${encodeURIComponent(params.version)}`,
    fetchImpl: fetch,
    method: "DELETE",
    okStatuses: [200, 404],
  });
  return response.status;
}
