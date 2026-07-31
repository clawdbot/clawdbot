// Telegram spool mapping: update_id encoding and lane derivation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import {
  openTelegramIngressQueue,
  resolveTelegramIngressSpoolDir,
  telegramSpooledUpdateLaneKey,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";
import {
  listTelegramSpooledUpdates,
  telegramQueueEventId,
} from "./telegram-ingress-spool.test-support.js";

async function withTempState<T>(
  fn: (stateDir: string, spoolDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-spool-"));
  const spoolDir = resolveTelegramIngressSpoolDir({
    accountId: "acct",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  });
  setTelegramRuntime({
    state: {
      resolveStateDir: () => stateDir,
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => createChannelIngressQueue({ ...options, channelId: "telegram" }),
    },
  } as never);
  try {
    return await fn(stateDir, spoolDir);
  } finally {
    clearTelegramRuntimeForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  clearTelegramRuntimeForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("telegram ingress spool mapping", () => {
  it("encodes update_id as zero-padded event id", () => {
    expect(telegramQueueEventId(7)).toBe("0000000000000007");
    expect(telegramQueueEventId(42)).toBe("0000000000000042");
  });

  it("derives per-chat and per-topic lane keys", () => {
    expect(
      telegramSpooledUpdateLaneKey({
        update_id: 1,
        message: { chat: { id: 100 }, message_id: 1, text: "hi" },
      }),
    ).toContain("100");
    const topicLane = telegramSpooledUpdateLaneKey({
      update_id: 2,
      message: {
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 99,
        is_topic_message: true,
        message_id: 2,
        text: "topic",
      },
    });
    expect(topicLane).toBe("telegram:-100123:topic:99");
  });

  it("enqueues under the padded event id with lane key", async () => {
    await withTempState(async (_stateDir, spoolDir) => {
      const updateId = await writeTelegramSpooledUpdate({
        spoolDir,
        update: {
          update_id: 9,
          message: { chat: { id: 55 }, message_id: 1, text: "mapped" },
        },
      });
      expect(updateId).toBe(9);
      const pending = await listTelegramSpooledUpdates({ spoolDir, limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.updateId).toBe(9);

      const queue = openTelegramIngressQueue(spoolDir);
      const rows = await queue.listPending({ limit: "all" });
      expect(rows[0]?.id).toBe(telegramQueueEventId(9));
      expect(rows[0]?.laneKey).toBeTruthy();
    });
  });
});
