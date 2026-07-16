import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMatrixQaCliBackupRestoreFailed } from "./scenario-runtime-e2ee-destructive-recovery.js";
import { mutateMatrixQaCliStateLoss } from "./scenario-runtime-e2ee-state.js";

const testing = { assertMatrixQaCliBackupRestoreFailed };

const storageMetadataRuntime = vi.hoisted(() => ({
  normalizeMatrixStorageMetadata(value: unknown) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const metadata = value as { deviceId?: unknown; userId?: unknown };
    return {
      ...(typeof metadata.deviceId === "string" ? { deviceId: metadata.deviceId } : {}),
      ...(typeof metadata.userId === "string" ? { userId: metadata.userId } : {}),
    };
  },
  openMatrixStorageMetaStoreOptions(storageRootDir: string) {
    return {
      namespace: "storage-meta",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: storageRootDir },
    };
  },
}));

vi.mock("../substrate/e2ee-client.js", () => ({
  loadMatrixQaE2eeRuntime: async () => ({
    ...storageMetadataRuntime,
    openMatrixRecoveryKeyStoreOptions: (storageRootDir: string) => ({
      namespace: "recovery-key",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: storageRootDir },
    }),
  }),
}));

describe("Matrix destructive E2EE storage discovery", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("finds account metadata stored in account-local SQLite", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-storage-"));
    tempDirs.push(stateDir);
    const accountRoot = path.join(stateDir, "matrix", "accounts", "stored-key", "server", "token");
    createPluginStateSyncKeyedStoreForTests(
      "matrix",
      storageMetadataRuntime.openMatrixStorageMetaStoreOptions(accountRoot),
    ).register("current", {
      deviceId: "DEVICE",
      userId: "@owner:matrix-qa.test",
    });
    resetPluginStateStoreForTests();

    await expect(
      mutateMatrixQaCliStateLoss({
        deviceId: "DEVICE",
        preserveRecoveryKey: false,
        runtime: { stateDir },
        userId: "@owner:matrix-qa.test",
      }),
    ).resolves.toMatchObject({ accountRoot });
  });
});

describe("Matrix destructive E2EE backup failure assertions", () => {
  it("requires a nonzero CLI exit", () => {
    expect(() =>
      testing.assertMatrixQaCliBackupRestoreFailed(
        {
          payload: {
            backup: { decryptionKeyCached: false },
            backupVersion: "1",
            error: "backup key unavailable",
            success: false,
          },
          result: { exitCode: 0 },
        },
        {
          expectedBackupVersion: "1",
          failureKind: "missing-recovery-key",
          label: "restore",
        },
      ),
    ).toThrow("returned a successful exit code");
  });

  it("rejects unrelated CLI failures without backup-key evidence", () => {
    expect(() =>
      testing.assertMatrixQaCliBackupRestoreFailed(
        {
          payload: {
            backup: { decryptionKeyCached: false },
            backupVersion: "1",
            error: "network unavailable",
            success: false,
          },
          result: { exitCode: 1 },
        },
        {
          expectedBackupVersion: "1",
          failureKind: "missing-recovery-key",
          label: "restore",
        },
      ),
    ).toThrow("without the expected missing-recovery-key diagnostic");
  });

  it("accepts a failed restore with structured backup-key evidence", () => {
    expect(() =>
      testing.assertMatrixQaCliBackupRestoreFailed(
        {
          payload: {
            backup: {
              keyLoadError: "Error decrypting secret: Bad MAC",
              matchesDecryptionKey: false,
            },
            backupVersion: "1",
            error: "Matrix room key backup is not usable",
            success: false,
          },
          result: { exitCode: 1 },
        },
        {
          expectedBackupVersion: "1",
          failureKind: "rejected-recovery-key",
          label: "restore",
        },
      ),
    ).not.toThrow();
  });

  it("rejects a wrapper-only key-mismatch diagnostic", () => {
    expect(() =>
      testing.assertMatrixQaCliBackupRestoreFailed(
        {
          payload: {
            backup: { matchesDecryptionKey: false },
            backupVersion: "1",
            error: "backup key mismatch",
            success: false,
          },
          result: { exitCode: 1 },
        },
        {
          expectedBackupVersion: "1",
          failureKind: "rejected-recovery-key",
          label: "restore",
        },
      ),
    ).toThrow("without the expected rejected-recovery-key diagnostic");
  });

  it("accepts the SDK secret-storage load diagnostic", () => {
    expect(() =>
      testing.assertMatrixQaCliBackupRestoreFailed(
        {
          payload: {
            backup: {
              decryptionKeyCached: false,
              keyLoadError: "getSecretStorageKey callback returned falsey",
            },
            backupVersion: "1",
            error:
              "Matrix room key backup is not usable: backup decryption key could not be loaded from secret storage (getSecretStorageKey callback returned falsey).",
            success: false,
          },
          result: { exitCode: 1 },
        },
        {
          expectedBackupVersion: "1",
          failureKind: "missing-recovery-key",
          label: "restore",
        },
      ),
    ).not.toThrow();
  });
});
