// WhatsApp durable ingress drain adapter: completion, retry, and lane serialization.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  deserializeWhatsAppDurableInboundMessage,
  serializeWhatsAppDurableInboundMessage,
} from "./durable-payload.js";
import { createWhatsAppIngressMonitor } from "./durable-receive.js";

type WhatsAppDurableInboundPayload = {
  message: ReturnType<typeof serializeWhatsAppDurableInboundMessage>;
  upsertType?: string;
  skipStaleAppend?: boolean;
  skipRecentOutboundEcho?: boolean;
  receivedAt: number;
  receiveOrder?: number;
};

const REMOTE_JID = "1@s.whatsapp.net";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function message(id: string, remoteJid = REMOTE_JID): WAMessage {
  return {
    key: { remoteJid, id, fromMe: false },
    message: { conversation: "hi" },
  };
}

function eventId(id: string, remoteJid = REMOTE_JID): string {
  return createHash("sha256").update(`${remoteJid}\n${id}`).digest("hex");
}

function payload(id: string, remoteJid = REMOTE_JID): WhatsAppDurableInboundPayload {
  return {
    message: serializeWhatsAppDurableInboundMessage(message(id, remoteJid)),
    receivedAt: 1,
  };
}

describe("createWhatsAppIngressMonitor", () => {
  it("rejects messages without a native id as a permanent ingress failure", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({ kind: "completed" }),
      });
      monitor.start();
      const missingIdMessage = {
        ...message("unused"),
        key: { remoteJid: REMOTE_JID, fromMe: false },
      } as WAMessage;

      await expect(
        monitor.admit({ message: missingIdMessage, receivedAt: 1 }, { receivedAt: 1 }),
      ).rejects.toMatchObject({
        name: "WhatsAppIngressPermanentError",
        reason: "missing-message-key",
      });
      await monitor.stop();
    });
  });

  it("releases claims when dispatch throws before adoption", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const id = eventId("msg-1");
      await queue.enqueue(id, payload("msg-1"), { laneKey: REMOTE_JID });

      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => {
          throw new Error("downstream callback rejected");
        },
      });

      monitor.start();
      await monitor.waitForIdle();

      const status = await queue.enqueue(id, payload("msg-1"), { laneKey: REMOTE_JID });
      expect(status.kind).not.toBe("completed");
      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === id)).toBe(true);
      await monitor.stop();
    });
  });

  it("propagates failed-retryable results as claim release", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const id = eventId("msg-2");
      await queue.enqueue(id, payload("msg-2"), { laneKey: REMOTE_JID });

      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({
          kind: "failed-retryable",
          error: new Error("downstream flush rejected"),
        }),
      });

      monitor.start();
      await monitor.waitForIdle();

      const pending = await queue.listPending({ limit: "all" });
      const row = pending.find((entry) => entry.id === id);
      expect(row).toBeDefined();
      expect((row?.attempts ?? 0) >= 1).toBe(true);
      await monitor.stop();
    });
  });

  it("tombstones after an explicit completed dispatch", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const id = eventId("msg-3");
      await queue.enqueue(id, payload("msg-3"), { laneKey: REMOTE_JID });

      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({ kind: "completed" }),
      });

      monitor.start();
      await monitor.waitForIdle();

      const status = await queue.enqueue(id, payload("msg-3"), { laneKey: REMOTE_JID });
      expect(status.kind).toBe("completed");
      await monitor.stop();
    });
  });

  it("keeps a second same-lane message pending until the first turn adopts", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const firstId = eventId("msg-4a");
      const secondId = eventId("msg-4b");
      await queue.enqueue(firstId, payload("msg-4a"), {
        laneKey: REMOTE_JID,
        receivedAt: 1,
      });
      await queue.enqueue(secondId, payload("msg-4b"), {
        laneKey: REMOTE_JID,
        receivedAt: 2,
      });

      const dispatched: string[] = [];
      let adoptFirst: (() => void | Promise<void>) | undefined;
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (inbound, lifecycle) => {
          const id = inbound.message.key.id;
          if (!id) {
            throw new Error("expected transport id");
          }
          dispatched.push(id);
          if (id === "msg-4a") {
            adoptFirst = lifecycle.onAdopted;
            return { kind: "deferred" as const };
          }
          return { kind: "completed" as const };
        },
      });

      monitor.start();
      await monitor.waitForIdle();

      // Core drain serializes a conversation lane: msg-4b cannot reach the
      // channel debouncer until msg-4a transfers into the reply lane.
      expect(dispatched).toEqual(["msg-4a"]);
      expect((await queue.listClaims()).map((row) => row.id)).toEqual([firstId]);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([secondId]);

      if (!adoptFirst) {
        throw new Error("expected first adoption callback");
      }
      await adoptFirst();
      await monitor.waitForIdle();

      expect(dispatched).toEqual(["msg-4a", "msg-4b"]);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      await monitor.stop();
    });
  });

  it("dispatches accepted pending records older than the legacy 30-day TTL", async () => {
    await withTempState(async (stateDir) => {
      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1_000;
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
        now: () => thirtyOneDaysAgo,
      });
      await queue.enqueue(eventId("msg-old"), payload("msg-old"), {
        laneKey: REMOTE_JID,
        receivedAt: thirtyOneDaysAgo,
      });

      const dispatched: string[] = [];
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (admission) => {
          const id = admission.message.key.id;
          if (!id) {
            throw new Error("expected transport id");
          }
          dispatched.push(id);
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect(dispatched).toEqual(["msg-old"]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
    });
  });

  it("dispatches every accepted pending record past the legacy 450-entry cap", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const transportIds = Array.from(
        { length: 451 },
        (_unused, index) => `msg-${String(index).padStart(3, "0")}`,
      );
      for (const [index, transportId] of transportIds.entries()) {
        await queue.enqueue(eventId(transportId), payload(transportId), {
          laneKey: REMOTE_JID,
          receivedAt: index + 1,
        });
      }

      const dispatched: string[] = [];
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (admission) => {
          const id = admission.message.key.id;
          if (!id) {
            throw new Error("expected transport id");
          }
          dispatched.push(id);
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect(dispatched.toSorted()).toEqual(transportIds.toSorted());
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
    });
  });

  it("keeps completed and failed replay guards bounded", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const prune = vi.spyOn(queue, "prune");
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({ kind: "completed" }),
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect(prune).toHaveBeenCalledWith({
        completedTtlMs: 7 * 24 * 60 * 60 * 1_000,
        completedMaxEntries: 5_000,
        failedTtlMs: 30 * 24 * 60 * 60 * 1_000,
        failedMaxEntries: 450,
        now: expect.any(Number),
      });
    });
  });
});

describe("WhatsApp durable message serialization", () => {
  it("preserves Long-like protobuf timestamps as seconds", () => {
    const timestamp = 1_700_000_000;
    const longLike = { low: timestamp, high: 0, unsigned: true, valueOf: () => timestamp };
    const serialized = serializeWhatsAppDurableInboundMessage({
      ...message("long-timestamp"),
      messageTimestamp: longLike,
    } as unknown as WAMessage);

    expect(deserializeWhatsAppDurableInboundMessage(serialized).messageTimestamp).toBe(timestamp);
  });

  it("carries receive-time skip decisions through admission and replay", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });

      const dispatched: Array<{
        upsertType?: string;
        skipStaleAppend?: boolean;
        skipRecentOutboundEcho?: boolean;
        receiveOrder?: number;
      }> = [];
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (admission) => {
          dispatched.push(admission);
          return { kind: "completed" };
        },
      });
      monitor.start();
      await expect(
        monitor.admit(
          {
            message: message("stale-append"),
            upsertType: "append",
            skipStaleAppend: true,
            skipRecentOutboundEcho: true,
            receivedAt: 1,
            receiveOrder: 7,
          },
          { receivedAt: 1 },
        ),
      ).resolves.toMatchObject({ kind: "durable", queueResult: { kind: "accepted" } });
      await monitor.waitForIdle();

      expect(dispatched).toEqual([
        expect.objectContaining({
          upsertType: "append",
          skipStaleAppend: true,
          skipRecentOutboundEcho: true,
          receivedAt: 1,
          receiveOrder: 7,
        }),
      ]);
      await monitor.stop();
    });
  });
});
