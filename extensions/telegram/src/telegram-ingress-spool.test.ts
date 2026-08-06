// Telegram spool mapping: update_id encoding and lane derivation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginTelegramPollRegistration } from "./poll-answer-context.js";
import { recordTelegramPollRegistryEntry } from "./poll-registry.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import {
  openTelegramIngressQueue,
  resolveTelegramIngressSpoolDir,
  resolveTelegramUpdateId,
} from "./telegram-ingress-spool.js";
import {
  listTelegramSpooledUpdates,
  telegramQueueEventId,
  telegramSpooledUpdateLaneKey,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.test-support.js";

async function withTempState<T>(
  fn: (stateDir: string, spoolDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-spool-"));
  const spoolDir = resolveTelegramIngressSpoolDir({
    accountId: "acct",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  });
  const openKeyedStore = <StoreValue>(
    options: Parameters<typeof createPluginStateKeyedStoreForTests<StoreValue>>[1],
  ) => createPluginStateKeyedStoreForTests<StoreValue>("telegram", options);
  setTelegramRuntime({
    state: {
      resolveStateDir: () => stateDir,
      openKeyedStore,
      openSyncKeyedStore: <StoreValue>(
        options: Parameters<typeof createPluginStateSyncKeyedStoreForTests<StoreValue>>[1],
      ) => createPluginStateSyncKeyedStoreForTests<StoreValue>("telegram", options),
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

  it("keeps a poll vote ahead of a later message from the same topic", async () => {
    await withTempState(async (_stateDir, spoolDir) => {
      await recordTelegramPollRegistryEntry({
        accountId: "acct",
        pollId: "poll-topic-order",
        chat: { id: -100123, type: "supergroup", title: "Reviewers", is_forum: true },
        messageId: 40,
        messageThreadId: 99,
        question: "Ready?",
        options: ["Yes", "No"],
      });
      const voteUpdate = {
        update_id: 9,
        poll_answer: {
          poll_id: "poll-topic-order",
          option_ids: [0],
          user: { id: 111, first_name: "Ada" },
        },
      };
      const messageUpdate = {
        update_id: 10,
        message: {
          chat: { id: -100123, type: "supergroup", title: "Reviewers", is_forum: true },
          from: { id: 111, first_name: "Ada" },
          is_topic_message: true,
          message_id: 41,
          message_thread_id: 99,
          text: "after vote",
        },
      };

      let releaseVote: (() => void) | undefined;
      const voteReleased = new Promise<void>((resolve) => {
        releaseVote = resolve;
      });
      if (!releaseVote) {
        throw new Error("Expected vote release resolver");
      }
      const dispatchOrder: number[] = [];
      const onError = vi.fn();
      const queue = openTelegramIngressQueue(spoolDir);
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg: { channels: { telegram: { groupPolicy: "open" } } } as OpenClawConfig,
        accountId: "acct",
        onError,
        dispatch: async (update) => {
          const updateId = resolveTelegramUpdateId(update);
          if (updateId === null) {
            throw new Error("Expected update id");
          }
          dispatchOrder.push(updateId);
          if (updateId === 9) {
            await voteReleased;
          }
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      const admissions = await Promise.all([
        monitor.admit(voteUpdate),
        monitor.admit(messageUpdate),
      ]);
      expect(admissions.map((result) => result.kind)).toEqual(["durable", "durable"]);
      expect(await queue.listPending({ limit: "all" })).toEqual([
        expect.objectContaining({
          id: telegramQueueEventId(9),
          payload: expect.objectContaining({
            preparedPollAnswer: {
              entry: expect.objectContaining({ messageThreadId: 99 }),
            },
          }),
        }),
        expect.objectContaining({ id: telegramQueueEventId(10) }),
      ]);
      await monitor.waitForPumpIdle();
      expect(onError).not.toHaveBeenCalled();
      expect(dispatchOrder).toEqual([9]);
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({ laneKey: "telegram:-100123:topic:99" }),
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([
        expect.objectContaining({ laneKey: "telegram:-100123:topic:99" }),
      ]);
      releaseVote();
      await monitor.waitForIdle();
      expect(dispatchOrder).toEqual([9, 10]);
      await monitor.stop();
    });
  });

  it("fences a pending poll vote to its topic without blocking unrelated admission", async () => {
    await withTempState(async (_stateDir, spoolDir) => {
      const entry = {
        pollId: "poll-pending-topic",
        chat: {
          id: -100123,
          type: "supergroup" as const,
          title: "Reviewers",
          is_forum: true as const,
        },
        messageId: 40,
        messageThreadId: 99,
        question: "Ready?",
        options: ["Yes", "No"],
      };
      const registration = beginTelegramPollRegistration({ accountId: "acct", entry });
      const voteUpdate = {
        update_id: 9,
        poll_answer: {
          poll_id: entry.pollId,
          option_ids: [0],
          user: { id: 111, first_name: "Ada" },
        },
      };
      const unrelatedUpdate = {
        update_id: 10,
        message: {
          chat: entry.chat,
          from: { id: 111, first_name: "Ada" },
          is_topic_message: true,
          message_id: 41,
          message_thread_id: 100,
          text: "unrelated topic",
        },
      };
      const sameTopicUpdate = {
        update_id: 11,
        message: {
          chat: entry.chat,
          from: { id: 111, first_name: "Ada" },
          is_topic_message: true,
          message_id: 42,
          message_thread_id: 99,
          text: "after vote",
        },
      };
      const dispatchOrder: number[] = [];
      const queue = openTelegramIngressQueue(spoolDir);
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg: { channels: { telegram: { groupPolicy: "open" } } } as OpenClawConfig,
        accountId: "acct",
        dispatch: (update) => {
          const updateId = resolveTelegramUpdateId(update);
          if (updateId === null) {
            throw new Error("Expected update id");
          }
          dispatchOrder.push(updateId);
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      await expect(
        Promise.all([
          monitor.admit(voteUpdate),
          monitor.admit(unrelatedUpdate),
          monitor.admit(sameTopicUpdate),
        ]),
      ).resolves.toMatchObject([{ kind: "durable" }, { kind: "durable" }, { kind: "durable" }]);
      await vi.waitFor(() => expect(dispatchOrder).toContain(10));
      expect(dispatchOrder).not.toContain(9);
      expect(dispatchOrder).not.toContain(11);
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({ laneKey: "telegram:-100123:topic:99" }),
      ]);

      registration.complete(entry);
      await monitor.waitForIdle();
      expect(dispatchOrder.indexOf(9)).toBeLessThan(dispatchOrder.indexOf(11));
      await monitor.stop();
    });
  });
});
