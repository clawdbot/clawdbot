import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "./scenario-runtime-e2ee-destructive.js";

const storageMetadataRuntime = {
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
};

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
      testing.findMatrixQaCliAccountRoot({
        deviceId: "DEVICE",
        runtime: { stateDir },
        storageMetadataRuntime,
        userId: "@owner:matrix-qa.test",
      }),
    ).resolves.toBe(accountRoot);
  });
});
