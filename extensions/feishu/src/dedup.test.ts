import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  hasProcessedFeishuMessage,
  testingHooks,
  tryRecordMessagePersistent,
  warmupDedupFromDisk,
} from "./dedup.js";
import { setFeishuRuntime } from "./runtime.js";

let tempDir: string | undefined;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-dedup-"));
  process.env.OPENCLAW_STATE_DIR = tempDir;
  setFeishuRuntime({
    state: {
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("feishu", options),
    },
  } as unknown as PluginRuntime);
  testingHooks.resetFeishuDedupForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  testingHooks.resetFeishuDedupForTests();
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

describe("Feishu persistent dedupe", () => {
  it("records message ids in plugin state", async () => {
    await expect(tryRecordMessagePersistent("msg-1", "account-a")).resolves.toBe(true);
    await expect(tryRecordMessagePersistent("msg-1", "account-a")).resolves.toBe(false);
    await expect(hasProcessedFeishuMessage("msg-1", "account-a")).resolves.toBe(true);
    await expect(hasProcessedFeishuMessage("msg-1", "account-b")).resolves.toBe(false);
  });

  it("warms memory from persisted plugin state", async () => {
    await expect(tryRecordMessagePersistent("msg-2", "account-a")).resolves.toBe(true);
    testingHooks.resetFeishuDedupMemoryForTests();

    await expect(warmupDedupFromDisk("account-a")).resolves.toBe(1);
    await expect(tryRecordMessagePersistent("msg-2", "account-a")).resolves.toBe(false);
  });

  it("ignores expired persisted entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await expect(tryRecordMessagePersistent("msg-3", "account-a")).resolves.toBe(true);
    testingHooks.resetFeishuDedupMemoryForTests();

    vi.setSystemTime(1_000 + 24 * 60 * 60 * 1000 + 1);
    await expect(hasProcessedFeishuMessage("msg-3", "account-a")).resolves.toBe(false);
  });

  it("imports legacy JSON dedupe entries before checking plugin state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const legacyPath = path.join(tempDir as string, "feishu", "dedup", "account-a.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        "msg-legacy": 1_000,
        "msg-expired": 2_000 - 24 * 60 * 60 * 1000 - 1,
      }),
      "utf8",
    );

    await expect(hasProcessedFeishuMessage("msg-legacy", "account-a")).resolves.toBe(true);
    await expect(tryRecordMessagePersistent("msg-legacy", "account-a")).resolves.toBe(false);
    await expect(hasProcessedFeishuMessage("msg-expired", "account-a")).resolves.toBe(false);
  });
});
