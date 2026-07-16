import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../../../test/helpers/temp-home.js";
import { resolveMatrixAccountStorageRoot } from "../../../runtime-api.js";
import type { MatrixRoomKeyBackupRestoreResult } from "../sdk.js";
import { maybeRestoreLegacyMatrixBackup } from "./legacy-crypto-restore.js";

function createBackupStatus() {
  return {
    serverVersion: "1",
    activeVersion: "1",
    trusted: true,
    matchesDecryptionKey: true,
    decryptionKeyCached: true,
    keyLoadAttempted: true,
    keyLoadError: null,
  };
}

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

const BASE_AUTH = {
  accountId: "default",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "tok-123",
};

type MatrixAuth = typeof BASE_AUTH;

function readLegacyMigrationState(rootDir: string) {
  const statePath = path.join(rootDir, "legacy-crypto-migration.json");
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
}

async function runLegacyRestoreScenario(params: {
  migration: Record<string, unknown>;
  auth?: MatrixAuth;
  sourceAuth?: MatrixAuth;
  restoreRoomKeyBackup: () => Promise<MatrixRoomKeyBackupRestoreResult>;
}) {
  return withTempHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const auth = params.auth ?? BASE_AUTH;
    const sourceAuth = params.sourceAuth ?? auth;
    const { rootDir } = resolveMatrixAccountStorageRoot({
      stateDir,
      ...auth,
    });
    const { rootDir: sourceRootDir } = resolveMatrixAccountStorageRoot({
      stateDir,
      ...sourceAuth,
    });

    writeFile(
      path.join(sourceRootDir, "legacy-crypto-migration.json"),
      JSON.stringify(params.migration),
    );

    const restoreRoomKeyBackup = vi.fn(params.restoreRoomKeyBackup);
    const result = await maybeRestoreLegacyMatrixBackup({
      client: { restoreRoomKeyBackup },
      auth,
      stateDir,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        HOME: home,
      },
    });

    return {
      result,
      restoreRoomKeyBackup,
      rootState: readLegacyMigrationState(rootDir),
      rootStateExists: fs.existsSync(path.join(rootDir, "legacy-crypto-migration.json")),
      sourceRootState: readLegacyMigrationState(sourceRootDir),
      sourceRootStateExists: fs.existsSync(
        path.join(sourceRootDir, "legacy-crypto-migration.json"),
      ),
    };
  });
}

describe("maybeRestoreLegacyMatrixBackup", () => {
  it("marks pending legacy backup restore as completed after success", async () => {
    const { result, sourceRootState } = await runLegacyRestoreScenario({
      migration: {
        version: 1,
        accountId: "default",
        roomKeyCounts: { total: 10, backedUp: 8 },
        restoreStatus: "pending",
      },
      restoreRoomKeyBackup: async () => ({
        success: true,
        restoredAt: "2026-03-08T10:00:00.000Z",
        imported: 8,
        total: 8,
        loadedFromSecretStorage: true,
        backupVersion: "1",
        backup: createBackupStatus(),
      }),
    });

    expect(result).toEqual({
      kind: "restored",
      imported: 8,
      total: 8,
      localOnlyKeys: 2,
    });
    const state = sourceRootState as {
      restoreStatus: string;
      importedCount: number;
      totalCount: number;
    };
    expect(state.restoreStatus).toBe("completed");
    expect(state.importedCount).toBe(8);
    expect(state.totalCount).toBe(8);
  });

  it("keeps the restore pending when startup restore fails", async () => {
    const { result, sourceRootState } = await runLegacyRestoreScenario({
      migration: {
        version: 1,
        accountId: "default",
        roomKeyCounts: { total: 5, backedUp: 5 },
        restoreStatus: "pending",
      },
      restoreRoomKeyBackup: async () => ({
        success: false,
        error: "backup unavailable",
        imported: 0,
        total: 0,
        loadedFromSecretStorage: false,
        backupVersion: null,
        backup: createBackupStatus(),
      }),
    });

    expect(result).toEqual({
      kind: "failed",
      error: "backup unavailable",
      localOnlyKeys: 0,
    });
    const state = sourceRootState as {
      restoreStatus: string;
      lastError: string;
    };
    expect(state.restoreStatus).toBe("pending");
    expect(state.lastError).toBe("backup unavailable");
  });

  it("restores from a sibling token-hash directory when the access token changed", async () => {
    const oldAuth = {
      ...BASE_AUTH,
      accessToken: "tok-old",
    };
    const newAuth = {
      ...oldAuth,
      accessToken: "tok-new",
    };
    const {
      result,
      rootStateExists: newRootStateExists,
      sourceRootState,
    } = await runLegacyRestoreScenario({
      auth: newAuth,
      sourceAuth: oldAuth,
      migration: {
        version: 1,
        accountId: "default",
        roomKeyCounts: { total: 3, backedUp: 3 },
        restoreStatus: "pending",
      },
      restoreRoomKeyBackup: async () => ({
        success: true,
        restoredAt: "2026-03-08T10:00:00.000Z",
        imported: 3,
        total: 3,
        loadedFromSecretStorage: true,
        backupVersion: "1",
        backup: createBackupStatus(),
      }),
    });

    expect(result).toEqual({
      kind: "restored",
      imported: 3,
      total: 3,
      localOnlyKeys: 0,
    });
    const oldState = sourceRootState as {
      restoreStatus: string;
    };
    expect(oldState.restoreStatus).toBe("completed");
    expect(newRootStateExists).toBe(false);
  });
});
