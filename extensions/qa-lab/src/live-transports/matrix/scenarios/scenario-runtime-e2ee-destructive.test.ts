import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertMatrixQaCliBackupRestoreFailed } from "./scenario-runtime-e2ee-destructive-recovery.js";
import { mutateMatrixQaCliStateLoss } from "./scenario-runtime-e2ee-state.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const testing = { assertMatrixQaCliBackupRestoreFailed };

const destructiveScenarioMocks = vi.hoisted(() => ({
  createMatrixQaClient: vi.fn(),
  createMatrixQaE2eeScenarioClient: vi.fn(),
  createMatrixQaRecoveryCliRuntime: vi.fn(),
  loginMatrixQaRecoveryDevice: vi.fn(),
  runMatrixQaCliJson: vi.fn(),
  createMatrixQaDriverScenarioClient: vi.fn(),
  readMatrixQaGatewayMatrixAccount: vi.fn(),
  replaceMatrixQaGatewayMatrixAccount: vi.fn(),
  waitForMatrixSyncStoreWithCursor: vi.fn(),
  deleteMatrixSyncStoreCursor: vi.fn(),
}));

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

vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: destructiveScenarioMocks.createMatrixQaClient,
}));

vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: destructiveScenarioMocks.createMatrixQaE2eeScenarioClient,
  loadMatrixQaE2eeRuntime: async () => ({
    ...storageMetadataRuntime,
    openMatrixRecoveryKeyStoreOptions: (storageRootDir: string) => ({
      namespace: "recovery-key",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: storageRootDir },
    }),
  }),
}));

vi.mock("./scenario-runtime-e2ee-destructive-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-e2ee-destructive-recovery.js")>()),
  createMatrixQaRecoveryCliRuntime: destructiveScenarioMocks.createMatrixQaRecoveryCliRuntime,
  loginMatrixQaRecoveryDevice: destructiveScenarioMocks.loginMatrixQaRecoveryDevice,
  runMatrixQaCliJson: destructiveScenarioMocks.runMatrixQaCliJson,
}));

vi.mock("./scenario-runtime-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-shared.js")>()),
  createMatrixQaDriverScenarioClient: destructiveScenarioMocks.createMatrixQaDriverScenarioClient,
}));

vi.mock("./scenario-runtime-config.js", () => ({
  readMatrixQaGatewayMatrixAccount: destructiveScenarioMocks.readMatrixQaGatewayMatrixAccount,
  replaceMatrixQaGatewayMatrixAccount: destructiveScenarioMocks.replaceMatrixQaGatewayMatrixAccount,
}));

vi.mock("./scenario-runtime-state-files.js", () => ({
  waitForMatrixSyncStoreWithCursor: destructiveScenarioMocks.waitForMatrixSyncStoreWithCursor,
  deleteMatrixSyncStoreCursor: destructiveScenarioMocks.deleteMatrixSyncStoreCursor,
}));

import {
  runMatrixQaE2eeSyncStateLossCryptoIntactScenario,
  runMatrixQaE2eeWrongAccountRecoveryKeyScenario,
} from "./scenario-runtime-e2ee-destructive.js";

function createDisposableOwner(params: {
  backupVersion: string;
  cleanupOrder?: string[];
  encodedRecoveryKey: string;
  failCleanup?: boolean;
  label: string;
}) {
  return {
    bootstrapOwnDeviceVerification: vi.fn(async () => ({
      success: true,
      verification: {
        backupVersion: params.backupVersion,
        crossSigningVerified: true,
        verified: true,
      },
    })),
    deleteOwnDevices: vi.fn(async (deviceIds: string[]) => {
      params.cleanupOrder?.push(`${params.label}:delete:${deviceIds.join(",")}`);
      if (params.failCleanup) {
        throw new Error(`${params.label} device cleanup failed`);
      }
      return {};
    }),
    getRecoveryKey: vi.fn(async () => ({
      encodedPrivateKey: params.encodedRecoveryKey,
      keyId: `${params.label}-key`,
    })),
    sendTextMessage: vi.fn(async () => `$${params.label}-seed`),
    stop: vi.fn(async () => {
      params.cleanupOrder?.push(`${params.label}:stop`);
      if (params.failCleanup) {
        throw new Error(`${params.label} stop failed`);
      }
    }),
  };
}

function createWrongAccountContext(): MatrixQaScenarioContext {
  const context = {
    baseUrl: "http://127.0.0.1:28123",
    driverAccessToken: "unused-driver-token",
    driverUserId: "@unused-driver:matrix-qa.test",
    observedEvents: [],
    observerAccessToken: "must-not-read",
    observerDeviceId: "must-not-read",
    observerPassword: "must-not-read",
    observerUserId: "must-not-read",
    outputDir: "/tmp/matrix-qa-output",
    registrationToken: "registration-token",
    roomId: "!unused:matrix-qa.test",
    sutAccessToken: "unused-sut-token",
    sutUserId: "@unused-sut:matrix-qa.test",
    syncState: {},
    timeoutMs: 30_000,
    topology: { rooms: [] },
  } as unknown as MatrixQaScenarioContext;
  return new Proxy(context, {
    get(target, property, receiver) {
      if (typeof property === "string" && property.startsWith("observer")) {
        throw new Error(`observer credential read: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Matrix sync-state loss driver readiness", () => {
  it.each([false, true])(
    "awaits target room sync before sending (sync fails=%s)",
    async (fails) => {
      const order: string[] = [];
      const account = {
        accessToken: "replacement-token",
        deviceId: "REPLACEMENT",
        password: "replacement-password",
        userId: "@replacement:matrix-qa.test",
      };
      const roomId = "!recovery:matrix-qa.test";
      const driver = {
        prime: vi.fn(async () => "driver-cursor"),
        waitForJoinedMember: vi.fn(async () => {
          order.push("wait");
          await Promise.resolve();
          if (fails) {
            throw new Error("membership sync failed");
          }
          order.push("synced");
        }),
        sendTextMessage: vi.fn(async () => {
          order.push("send");
          throw new Error("send reached");
        }),
        stop: vi.fn(async () => {}),
      };
      destructiveScenarioMocks.createMatrixQaClient.mockReturnValue({
        registerWithToken: vi.fn(async () => account),
        joinRoom: vi.fn(async () => {}),
      });
      destructiveScenarioMocks.createMatrixQaDriverScenarioClient.mockReturnValue({
        createPrivateRoom: vi.fn(async () => roomId),
        primeRoom: vi.fn(async () => "raw-cursor"),
      });
      destructiveScenarioMocks.createMatrixQaE2eeScenarioClient.mockResolvedValue(driver);
      destructiveScenarioMocks.readMatrixQaGatewayMatrixAccount.mockResolvedValue({
        enabled: true,
      });
      destructiveScenarioMocks.waitForMatrixSyncStoreWithCursor.mockResolvedValue({
        cursor: "saved-cursor",
        pathname: "/tmp/unused-sync-store",
        source: "sqlite",
        stateKey: "saved",
      });
      const context = createMatrixQaE2eeTestContext({
        gatewayStateDir: "/tmp/unused-gateway-state",
        gatewayRuntimeEnv: { OPENCLAW_CONFIG_PATH: "/tmp/unused-gateway-config" },
        restartGatewayAfterStateMutation: async (mutate) => {
          await mutate({ stateDir: "/tmp/unused-gateway-state" });
        },
      });

      await expect(runMatrixQaE2eeSyncStateLossCryptoIntactScenario(context)).rejects.toThrow(
        fails ? "membership sync failed" : "send reached",
      );
      expect(driver.waitForJoinedMember).toHaveBeenCalledWith({
        roomId,
        timeoutMs: context.timeoutMs,
        userId: account.userId,
      });
      expect(order).toEqual(fails ? ["wait"] : ["wait", "synced", "send"]);
      expect(driver.stop).toHaveBeenCalledOnce();
      expect(destructiveScenarioMocks.replaceMatrixQaGatewayMatrixAccount).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountId: "sut", accountConfig: { enabled: true } }),
      );
    },
  );
});

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

describe("Matrix wrong-account recovery-key isolation", () => {
  it("uses disposable source and target owners without reading observer credentials", async () => {
    const cleanupOrder: string[] = [];
    const sourceOwner = createDisposableOwner({
      backupVersion: "source-backup",
      cleanupOrder,
      encodedRecoveryKey: "source-recovery-key",
      failCleanup: true,
      label: "source",
    });
    const targetOwner = createDisposableOwner({
      backupVersion: "target-backup",
      cleanupOrder,
      encodedRecoveryKey: "target-recovery-key",
      failCleanup: true,
      label: "target",
    });
    const registerWithToken = vi
      .fn()
      .mockResolvedValueOnce({
        accessToken: "source-token",
        deviceId: "SOURCE-DEVICE",
        password: "source-password",
        userId: "@source:matrix-qa.test",
      })
      .mockResolvedValueOnce({
        accessToken: "target-token",
        deviceId: "TARGET-DEVICE",
        password: "target-password",
        userId: "@target:matrix-qa.test",
      });
    destructiveScenarioMocks.createMatrixQaClient.mockReturnValue({
      createPrivateRoom: vi
        .fn()
        .mockResolvedValueOnce("!source:matrix-qa.test")
        .mockResolvedValueOnce("!target:matrix-qa.test"),
      registerWithToken,
    });
    destructiveScenarioMocks.createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce(sourceOwner)
      .mockResolvedValueOnce(targetOwner);
    destructiveScenarioMocks.loginMatrixQaRecoveryDevice.mockResolvedValue({
      accessToken: "target-recovery-token",
      deviceId: "TARGET-RECOVERY-DEVICE",
      userId: "@target:matrix-qa.test",
    });
    destructiveScenarioMocks.createMatrixQaRecoveryCliRuntime.mockResolvedValue({
      dispose: vi.fn(async () => {
        cleanupOrder.push("cli:dispose");
        throw new Error("CLI cleanup failed");
      }),
    });
    destructiveScenarioMocks.runMatrixQaCliJson.mockResolvedValue({
      artifacts: { stderrPath: "/tmp/stderr", stdoutPath: "/tmp/stdout" },
      payload: {
        backup: {
          decryptionKeyCached: false,
          keyLoadError: "bad MAC",
          matchesDecryptionKey: false,
        },
        backupVersion: "target-backup",
        error: "bad MAC",
        success: false,
      },
      result: { exitCode: 1 },
    });

    const result = await runMatrixQaE2eeWrongAccountRecoveryKeyScenario(
      createWrongAccountContext(),
    );

    expect(registerWithToken).toHaveBeenCalledTimes(2);
    expect(destructiveScenarioMocks.createMatrixQaE2eeScenarioClient).toHaveBeenCalledTimes(2);
    expect(destructiveScenarioMocks.loginMatrixQaRecoveryDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "target-password",
        userId: "@target:matrix-qa.test",
      }),
    );
    expect(destructiveScenarioMocks.runMatrixQaCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ stdin: "source-recovery-key\n" }),
    );
    expect(result.artifacts).toMatchObject({
      restoreExitCode: 1,
      targetRecoveryDeviceId: "TARGET-RECOVERY-DEVICE",
    });
    expect(cleanupOrder).toEqual([
      "cli:dispose",
      "target:delete:TARGET-RECOVERY-DEVICE",
      "target:stop",
      "source:stop",
    ]);
    expect(targetOwner.deleteOwnDevices).toHaveBeenCalledOnce();
    expect(targetOwner.stop).toHaveBeenCalledOnce();
    expect(sourceOwner.stop).toHaveBeenCalledOnce();
  });

  it("releases the source owner when target setup fails", async () => {
    const sourceOwner = createDisposableOwner({
      backupVersion: "source-backup",
      encodedRecoveryKey: "source-recovery-key",
      label: "source",
    });
    const registerWithToken = vi
      .fn()
      .mockResolvedValueOnce({
        accessToken: "source-token",
        deviceId: "SOURCE-DEVICE",
        password: "source-password",
        userId: "@source:matrix-qa.test",
      })
      .mockRejectedValueOnce(new Error("target registration failed"));
    destructiveScenarioMocks.createMatrixQaClient.mockReturnValue({
      createPrivateRoom: vi.fn().mockResolvedValue("!source:matrix-qa.test"),
      registerWithToken,
    });
    destructiveScenarioMocks.createMatrixQaE2eeScenarioClient.mockResolvedValueOnce(sourceOwner);

    await expect(
      runMatrixQaE2eeWrongAccountRecoveryKeyScenario(createWrongAccountContext()),
    ).rejects.toThrow("target registration failed");

    expect(sourceOwner.stop).toHaveBeenCalledOnce();
    expect(destructiveScenarioMocks.createMatrixQaRecoveryCliRuntime).not.toHaveBeenCalled();
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

  it("accepts the SDK bad-MAC diagnostic from the restore error", () => {
    expect(() =>
      testing.assertMatrixQaCliBackupRestoreFailed(
        {
          payload: {
            backup: {
              decryptionKeyCached: false,
              keyLoadError: "getSecretStorageKey callback returned falsey",
              matchesDecryptionKey: false,
            },
            backupVersion: "1",
            error:
              "Matrix room key backup is not usable: backup decryption key could not be loaded from secret storage (Error decrypting secret m.megolm_backup.v1: bad MAC).",
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
