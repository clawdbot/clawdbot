// Feishu tests cover dedup plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuDedupeState } from "./dedup-state.js";
import {
  claimUnprocessedFeishuMessage,
  finalizeFeishuMessageProcessing,
  hasProcessedFeishuMessage,
  recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing,
  warmupDedupFromPluginState,
} from "./dedup.js";

let tempDir: string | undefined;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-dedup-"));
  process.env.OPENCLAW_STATE_DIR = tempDir;
  feishuDedupeState.reset();
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

// Simulates a process restart: a fresh guard has empty memory and no in-flight
// claims, so any duplicate verdict must come from the persisted SQLite rows.
async function restartFeishuDedup(): Promise<void> {
  feishuDedupeState.reset();
}

describe("Feishu claimable dedupe", () => {
  it("drops a duplicate message within the TTL after commit", async () => {
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-1", namespace: "account-a" }),
    ).resolves.toBe("claimed");
    await expect(recordProcessedFeishuMessage("msg-1", "account-a")).resolves.toBe(true);

    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-1", namespace: "account-a" }),
    ).resolves.toBe("duplicate");
    await expect(hasProcessedFeishuMessage("msg-1", "account-a")).resolves.toBe(true);
    await expect(hasProcessedFeishuMessage("msg-1", "account-b")).resolves.toBe(false);
  });

  it("reports an in-flight claim and lets a released claim retry", async () => {
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-2", namespace: "account-a" }),
    ).resolves.toBe("claimed");
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-2", namespace: "account-a" }),
    ).resolves.toBe("inflight");

    releaseFeishuMessageProcessing("msg-2", "account-a");
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-2", namespace: "account-a" }),
    ).resolves.toBe("claimed");
  });

  it("does not persist released claims across a restart", async () => {
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-3", namespace: "account-a" }),
    ).resolves.toBe("claimed");
    releaseFeishuMessageProcessing("msg-3", "account-a");

    await restartFeishuDedup();
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-3", namespace: "account-a" }),
    ).resolves.toBe("claimed");
  });

  it("prevents replay after a restart once a message is committed", async () => {
    await expect(
      finalizeFeishuMessageProcessing({ messageId: "msg-4", namespace: "account-a" }),
    ).resolves.toBe(true);

    await restartFeishuDedup();
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-4", namespace: "account-a" }),
    ).resolves.toBe("duplicate");
    await expect(
      finalizeFeishuMessageProcessing({ messageId: "msg-4", namespace: "account-a" }),
    ).resolves.toBe(false);
  });

  it("commits a held claim without reclaiming it", async () => {
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-5", namespace: "account-a" }),
    ).resolves.toBe("claimed");
    await expect(
      finalizeFeishuMessageProcessing({
        messageId: "msg-5",
        namespace: "account-a",
        claimHeld: true,
      }),
    ).resolves.toBe(true);
    await expect(
      finalizeFeishuMessageProcessing({
        messageId: "msg-5",
        namespace: "account-a",
        claimHeld: true,
      }),
    ).resolves.toBe(false);
  });

  it("dedupes cross-account broadcast claims through the shared namespace", async () => {
    // Multi-account groups deliver the same event once per bot account; the
    // shared "broadcast" namespace lets the first account claim dispatch.
    await expect(recordProcessedFeishuMessage("msg-6", "broadcast")).resolves.toBe(true);
    await expect(recordProcessedFeishuMessage("msg-6", "broadcast")).resolves.toBe(false);

    await restartFeishuDedup();
    await expect(recordProcessedFeishuMessage("msg-6", "broadcast")).resolves.toBe(false);
  });

  it("warms memory from persisted plugin state", async () => {
    await expect(recordProcessedFeishuMessage("msg-7", "account-a")).resolves.toBe(true);
    await restartFeishuDedup();

    await expect(warmupDedupFromPluginState("account-a")).resolves.toBe(1);
    await expect(recordProcessedFeishuMessage("msg-7", "account-a")).resolves.toBe(false);
  });

  it("ignores committed messages after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await expect(recordProcessedFeishuMessage("msg-8", "account-a")).resolves.toBe(true);
    await restartFeishuDedup();

    vi.setSystemTime(1_000 + 24 * 60 * 60 * 1000 + 1);
    await expect(hasProcessedFeishuMessage("msg-8", "account-a")).resolves.toBe(false);
  });

  it("keeps deduping in memory and logs when plugin-state persistence fails", async () => {
    // A regular file where the state dir should be makes every SQLite open fail.
    const blockedPath = path.join(tempDir as string, "not-a-dir");
    fs.writeFileSync(blockedPath, "x", "utf8");
    process.env.OPENCLAW_STATE_DIR = path.join(blockedPath, "nested");
    const log = vi.fn();

    await expect(recordProcessedFeishuMessage("msg-9", "account-a", log)).resolves.toBe(true);
    await expect(
      claimUnprocessedFeishuMessage({ messageId: "msg-9", namespace: "account-a", log }),
    ).resolves.toBe("duplicate");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("feishu-dedup: persistent state error"),
    );
  });
});
