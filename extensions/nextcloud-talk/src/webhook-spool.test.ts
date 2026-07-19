// Nextcloud Talk durable ingress tests cover recovery, tombstones, identity, and shutdown.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { migrateNextcloudTalkLegacyReplayState } from "./webhook-spool-state.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

type NextcloudTalkIngressQueue = NonNullable<
  Parameters<typeof createNextcloudTalkWebhookSpool>[0]["queue"]
>;
type NextcloudTalkIngressPayload = Parameters<NextcloudTalkIngressQueue["enqueue"]>[1];
type NextcloudTalkIngressDeliver = Parameters<typeof createNextcloudTalkWebhookSpool>[0]["deliver"];

function createRawEvent(params?: { messageId?: string; roomToken?: string; text?: string }) {
  const { body } = createSignedCreateMessageRequest();
  const payload = JSON.parse(body) as {
    object: { id: string; content: string; name: string };
    target: { id: string };
  };
  payload.object.id = params?.messageId ?? "msg-1";
  payload.target.id = params?.roomToken ?? "test-room-token";
  payload.object.content = params?.text ?? "hello";
  payload.object.name = params?.text ?? "hello";
  return JSON.stringify(payload);
}

function startSpool(queue: NextcloudTalkIngressQueue, deliver: NextcloudTalkIngressDeliver) {
  return createNextcloudTalkWebhookSpool({
    accountId: "default",
    queue,
    deliver,
    runtime: { error: vi.fn(), log: vi.fn() },
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
    legacyReplayStore: null,
  });
}

async function withQueue<T>(fn: (queue: NextcloudTalkIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
    channelId: "nextcloud-talk",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Nextcloud Talk durable ingress", () => {
  it("migrates the shipped replay guard window into completion tombstones", async () => {
    await withQueue(async (queue) => {
      const seenAt = Date.now();
      const store = {
        entries: vi.fn(async () => [{ value: { key: "test-room:msg-legacy", seenAt } }]),
        clear: vi.fn(async () => {}),
      };

      await expect(migrateNextcloudTalkLegacyReplayState({ queue, store })).resolves.toBe(1);
      expect((await queue.enqueue("msg-legacy", {} as NextcloudTalkIngressPayload)).kind).toBe(
        "completed",
      );
      expect(store.clear).toHaveBeenCalledTimes(1);
    });
  });

  it("propagates append failure without live-dispatch fallback", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies NextcloudTalkIngressQueue;
      const deliver = vi.fn();
      const spool = startSpool(failingQueue, deliver);
      try {
        await expect(spool.receive(createRawEvent())).rejects.toBe(appendError);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await spool.stop();
      }
    });
  });

  it("recovers an uncompleted webhook with a fresh drain exactly once", async () => {
    await withQueue(async (queue) => {
      const interruptedDeliver = vi.fn(async (_message, lifecycle) => {
        lifecycle.onDeferred();
      });
      const interrupted = startSpool(queue, interruptedDeliver);
      await interrupted.receive(createRawEvent({ messageId: "msg-restart" }));
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();

      const recoveredDeliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startSpool(queue, recoveredDeliver);
      try {
        await recovered.waitForIdle();
        expect(recoveredDeliver).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("rejects a duplicate after completion", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const spool = startSpool(queue, deliver);
      try {
        const rawEvent = createRawEvent({ messageId: "msg-completed" });
        await spool.receive(rawEvent);
        await spool.waitForIdle();
        await spool.receive(rawEvent);
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("preserves the retired room-token plus message-id guard scenario", async () => {
    await withQueue(async (queue) => {
      const delivered: Array<[messageId: string, roomId: string]> = [];
      const spool = startSpool(queue, async (message, lifecycle) => {
        delivered.push([message.messageId, message.roomToken]);
        await lifecycle.onAdopted();
      });
      try {
        const replay = createRawEvent({ messageId: "msg-guard", roomToken: "test-room-token" });
        await spool.receive(replay);
        await spool.waitForIdle();
        await spool.receive(replay);
        await spool.waitForIdle();
        expect(delivered).toEqual([["msg-guard", "test-room-token"]]);
      } finally {
        await spool.stop();
      }
    });
  });

  it("stores the exact raw envelope in the room lane", async () => {
    await withQueue(async (queue) => {
      const rawEvent = createRawEvent({ messageId: "msg-raw", roomToken: "test-room-token" });
      const spool = startSpool(queue, async (_message, lifecycle) => {
        lifecycle.onDeferred();
      });
      try {
        await spool.receive(rawEvent);
        await spool.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "msg-raw",
            laneKey: "room:test-room-token",
            payload: expect.objectContaining({ rawEvent }),
          }),
        ]);
      } finally {
        await spool.stop();
      }
    });
  });

  it("completes a gated turn that does not dispatch", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {});
      const spool = startSpool(queue, deliver);
      try {
        const rawEvent = createRawEvent({ messageId: "msg-gated" });
        await spool.receive(rawEvent);
        await spool.waitForIdle();
        await spool.receive(rawEvent);
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("keeps the claim until adoption finalization reaches its terminal callback", async () => {
    await withQueue(async (queue) => {
      let adopt: (() => void | Promise<void>) | undefined;
      const deliver = vi.fn(async (_message, lifecycle) => {
        lifecycle.onAdoptionFinalizing();
        adopt = lifecycle.onAdopted;
      });
      const spool = startSpool(queue, deliver);
      try {
        const rawEvent = createRawEvent({ messageId: "msg-finalizing" });
        await spool.receive(rawEvent);
        await spool.waitForIdle();
        expect(await queue.listClaims()).toHaveLength(1);
        if (!adopt) {
          throw new Error("Expected adoption callback after finalization");
        }

        await adopt();
        await spool.receive(rawEvent);
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("ignores non-message events before they consume the message id", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn();
      const spool = startSpool(queue, deliver);
      try {
        const ignored = JSON.stringify({ type: "Update", object: { id: "msg-edit" } });
        await expect(spool.receive(ignored)).resolves.toBe("ignored");
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await spool.stop();
      }
    });
  });
});
