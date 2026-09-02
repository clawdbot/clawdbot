// Nextcloud Talk durable ingress tests cover recovery, tombstones, identity, and shutdown.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
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

function startSpool(
  queue: NextcloudTalkIngressQueue,
  deliver: NextcloudTalkIngressDeliver,
  log = vi.fn(),
) {
  return createNextcloudTalkWebhookSpool({
    accountId: "default",
    queue,
    deliver,
    runtime: { error: vi.fn(), log },
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
  it("does not start draining when migration completes after stop begins", async () => {
    await withQueue(async (queue) => {
      let releaseEntries: (() => void) | undefined;
      const entries = vi.fn(
        () =>
          new Promise<[]>((resolve) => {
            releaseEntries = () => resolve([]);
          }),
      );
      const prune = vi.spyOn(queue, "prune");
      const spool = createNextcloudTalkWebhookSpool({
        accountId: "default",
        queue,
        deliver: vi.fn(),
        runtime: { error: vi.fn(), log: vi.fn() },
        pollIntervalMs: 60_000,
        legacyReplayStore: { entries, clear: vi.fn(async () => {}) },
      });

      const stopping = spool.stop();
      await vi.waitFor(() => expect(entries).toHaveBeenCalledTimes(1));
      releaseEntries?.();
      await stopping;

      expect(prune).not.toHaveBeenCalled();
    });
  });

  it("finishes durable admission for a receive that began before migration-time stop", async () => {
    await withQueue(async (queue) => {
      let releaseEntries: (() => void) | undefined;
      const entries = vi.fn(
        () =>
          new Promise<[]>((resolve) => {
            releaseEntries = () => resolve([]);
          }),
      );
      const deliver = vi.fn();
      const spool = createNextcloudTalkWebhookSpool({
        accountId: "default",
        queue,
        deliver,
        runtime: { error: vi.fn(), log: vi.fn() },
        pollIntervalMs: 60_000,
        legacyReplayStore: { entries, clear: vi.fn(async () => {}) },
      });

      const receiving = spool.receive(createRawEvent({ messageId: "msg-before-stop" }));
      const stopping = spool.stop();
      await vi.waitFor(() => expect(entries).toHaveBeenCalledTimes(1));
      releaseEntries?.();

      await expect(receiving).resolves.toBe("accepted");
      await stopping;
      expect(deliver).not.toHaveBeenCalled();
      expect(await queue.listPending({ limit: "all" })).toHaveLength(1);
    });
  });

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

  it("drains other rooms while keeping unadopted same-room deliveries ordered", async () => {
    await withQueue(async (queue) => {
      let releaseRoomA!: () => void;
      const roomADelivery = new Promise<void>((resolve) => {
        releaseRoomA = resolve;
      });
      const delivered: string[] = [];
      const spool = startSpool(queue, async (message, lifecycle) => {
        delivered.push(message.messageId);
        if (message.messageId === "room-a-1") {
          await roomADelivery;
        }
        await lifecycle.onAdopted();
      });

      try {
        await spool.receive(createRawEvent({ messageId: "room-a-1", roomToken: "room-a" }));
        await vi.waitFor(() => expect(delivered).toEqual(["room-a-1"]));

        await spool.receive(createRawEvent({ messageId: "room-a-2", roomToken: "room-a" }));
        await spool.receive(createRawEvent({ messageId: "room-b-1", roomToken: "room-b" }));

        await vi.waitFor(() => expect(delivered).toEqual(["room-a-1", "room-b-1"]));
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "room-a-2", laneKey: "room:room-a" }),
        ]);

        releaseRoomA();
        await vi.waitFor(() => expect(delivered).toEqual(["room-a-1", "room-b-1", "room-a-2"]));
      } finally {
        releaseRoomA();
        await spool.stop();
      }
    });
  });

  it("caps active room deliveries after durable adoption across repeated pumps", async () => {
    await withQueue(async (queue) => {
      let releaseDeliveries!: () => void;
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDeliveries = resolve;
      });
      let activeDeliveries = 0;
      let maxActiveDeliveries = 0;
      const deliver = vi.fn(async (_message, lifecycle) => {
        activeDeliveries += 1;
        maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
        await lifecycle.onAdopted();
        try {
          await deliveryGate;
        } finally {
          activeDeliveries -= 1;
        }
      });
      const spool = startSpool(queue, deliver);

      try {
        for (let index = 0; index < 33; index += 1) {
          await spool.receive(
            createRawEvent({
              messageId: `room-delivery-${index}`,
              roomToken: `room-${index}`,
            }),
          );
        }

        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(32));
        expect(maxActiveDeliveries).toBe(32);
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "room-delivery-32", laneKey: "room:room-32" }),
        ]);

        releaseDeliveries();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(33));
        expect(maxActiveDeliveries).toBe(32);
      } finally {
        releaseDeliveries();
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

  it("logs non-message events before they consume the message id", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn();
      const log = vi.fn();
      const spool = startSpool(queue, deliver, log);
      try {
        const fileShare = JSON.stringify({
          type: "Create",
          actor: { type: "Person", id: "alice", name: "Alice" },
          object: {
            type: "Document",
            id: "file-1",
            name: "report.pdf",
            content: "",
            mediaType: "application/pdf",
          },
          target: { type: "Collection", id: "room-1", name: "Room 1" },
        });
        await expect(spool.receive(fileShare)).resolves.toBe("ignored");
        expect(log).toHaveBeenCalledWith(
          "nextcloud-talk: ignored non-message webhook event (type=Create objectType=Document)",
        );
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await spool.stop();
      }
    });
  });
});
