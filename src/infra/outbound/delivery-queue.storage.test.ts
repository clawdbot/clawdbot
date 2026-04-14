import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  loadPendingDeliveries,
  moveToFailed,
} from "./delivery-queue.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const queueDir = () => path.join(tmpDir(), "delivery-queue");
  const queueJsonFiles = () => fs.readdirSync(queueDir()).filter((file) => file.endsWith(".json"));
  const enqueueTextDelivery = (params: Parameters<typeof enqueueDelivery>[0], rootDir = tmpDir()) =>
    enqueueDelivery(params, rootDir);

  describe("enqueue + ack lifecycle", () => {
    it("creates and removes a queue entry", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "whatsapp",
          to: "+1555",
          payloads: [{ text: "hello" }],
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          gatewayClientScopes: ["operator.write"],
          mirror: {
            sessionKey: "agent:main:main",
            text: "hello",
            mediaUrls: ["https://example.com/file.png"],
          },
          session: {
            key: "agent:main:main",
            agentId: "agent-main",
            requesterAccountId: "acct-1",
            requesterSenderId: "sender-1",
          },
        },
        tmpDir(),
      );

      expect(queueJsonFiles()).toEqual([`${id}.json`]);

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry).toMatchObject({
        id,
        channel: "whatsapp",
        to: "+1555",
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        gatewayClientScopes: ["operator.write"],
        mirror: {
          sessionKey: "agent:main:main",
          text: "hello",
          mediaUrls: ["https://example.com/file.png"],
        },
        session: {
          key: "agent:main:main",
          agentId: "agent-main",
          requesterAccountId: "acct-1",
          requesterSenderId: "sender-1",
        },
        retryCount: 0,
      });
      expect(entry.payloads).toEqual([{ text: "hello" }]);

      await ackDelivery(id, tmpDir());
      expect(queueJsonFiles()).toHaveLength(0);
    });

    it("ack is idempotent (no error on missing file)", async () => {
      await expect(ackDelivery("nonexistent-id", tmpDir())).resolves.toBeUndefined();
    });

    it.each([
      {
        name: "ack cleans up leftover .delivered marker when .json is already gone",
        payload: { channel: "whatsapp", to: "+1", payloads: [{ text: "stale-marker" }] },
        prepareDeliveredMarker: true,
        action: (id: string) => ackDelivery(id, tmpDir()),
      },
      {
        name: "ack removes .delivered marker so recovery does not replay",
        payload: { channel: "whatsapp", to: "+1", payloads: [{ text: "ack-test" }] },
        action: (id: string) => ackDelivery(id, tmpDir()),
      },
      {
        name: "loadPendingDeliveries cleans up stale .delivered markers without replaying",
        payload: { channel: "telegram", to: "99", payloads: [{ text: "stale" }] },
        prepareDeliveredMarker: true,
        action: () => loadPendingDeliveries(tmpDir()),
        expectedEntriesLength: 0,
      },
    ])("$name", async ({ payload, prepareDeliveredMarker, action, expectedEntriesLength }) => {
      const id = await enqueueTextDelivery(payload);
      const deliveredPath = path.join(queueDir(), `${id}.delivered`);

      if (prepareDeliveredMarker) {
        fs.renameSync(path.join(queueDir(), `${id}.json`), deliveredPath);
      }

      const entries = await action(id);

      if (expectedEntriesLength !== undefined) {
        expect(entries).toHaveLength(expectedEntriesLength);
      }
      expect(fs.existsSync(deliveredPath)).toBe(false);
      expect(fs.existsSync(path.join(queueDir(), `${id}.json`))).toBe(false);
    });
  });

  describe("failDelivery", () => {
    it("increments retryCount, records attempt time, and sets lastError", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "telegram",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await failDelivery(id, "connection refused", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(typeof entry.lastAttemptAt).toBe("number");
      expect((entry.lastAttemptAt as number) > 0).toBe(true);
      expect(entry.lastError).toBe("connection refused");
    });
  });

  describe("moveToFailed", () => {
    it("moves entry to failed/ subdirectory", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "slack",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());

      const failedDir = path.join(queueDir(), "failed");
      expect(fs.existsSync(path.join(queueDir(), `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
    });
  });

  describe("loadPendingDeliveries", () => {
    it("returns empty array when queue directory does not exist", async () => {
      expect(await loadPendingDeliveries(path.join(tmpDir(), "no-such-dir"))).toEqual([]);
    });

    it("loads multiple entries", async () => {
      await enqueueTextDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] });
      await enqueueTextDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] });

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
    });

    it("persists gateway caller scopes for replay", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "telegram",
          to: "2",
          payloads: [{ text: "b" }],
          gatewayClientScopes: ["operator.write"],
        },
        tmpDir(),
      );

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.gatewayClientScopes).toEqual(["operator.write"]);
    });

    it("persists session context for recovery replay", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "telegram",
          to: "2",
          payloads: [{ text: "b" }],
          session: {
            key: "agent:main:main",
            agentId: "agent-main",
            requesterAccountId: "acct-1",
            requesterSenderId: "sender-1",
            requesterSenderName: "Sender One",
            requesterSenderUsername: "sender.one",
            requesterSenderE164: "+15551234567",
          },
        },
        tmpDir(),
      );

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.session).toEqual({
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
        requesterSenderName: "Sender One",
        requesterSenderUsername: "sender.one",
        requesterSenderE164: "+15551234567",
      });
    });

    it("backfills lastAttemptAt for legacy retry entries during load", async () => {
      const id = await enqueueTextDelivery({
        channel: "whatsapp",
        to: "+1",
        payloads: [{ text: "legacy" }],
      });
      const filePath = path.join(queueDir(), `${id}.json`);
      const legacyEntry = readQueuedEntry(tmpDir(), id);
      legacyEntry.retryCount = 2;
      delete legacyEntry.lastAttemptAt;
      fs.writeFileSync(filePath, JSON.stringify(legacyEntry), "utf-8");

      const entries = await loadPendingDeliveries(tmpDir());
      expect(entries).toHaveLength(1);
      expect(entries[0]?.lastAttemptAt).toBe(entries[0]?.enqueuedAt);

      const persisted = readQueuedEntry(tmpDir(), id);
      expect(persisted.lastAttemptAt).toBe(persisted.enqueuedAt);
    });
  });
});
