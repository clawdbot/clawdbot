// WhatsApp monitor inbox append behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getAuthDir,
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

/** Seed the credential Baileys would have written for a session that already synced. */
function writeSyncedCreds(accountSyncCounter: number) {
  fs.writeFileSync(
    path.join(getAuthDir(), "creds.json"),
    JSON.stringify({ accountSyncCounter }),
    "utf8",
  );
}

function emitUpsert(
  sock: { ev: { emit: (event: string, payload: unknown) => void } },
  params: {
    id: string;
    body: string;
    remoteJid: string;
    type: "append" | "notify";
    timestamp: unknown;
  },
) {
  sock.ev.emit("messages.upsert", {
    type: params.type,
    messages: [
      {
        key: { id: params.id, fromMe: false, remoteJid: params.remoteJid },
        message: { conversation: params.body },
        messageTimestamp: params.timestamp,
        pushName: "Tester",
      },
    ],
  });
}

describe("append upsert handling (#20952)", () => {
  installWebMonitorInboxUnitTestHooks();

  it.each([
    {
      name: "delivery coordinator processes recent append messages",
      id: "recent-1",
      body: "hello from group",
      remoteJid: "120363@g.us",
      type: "append" as const,
      timestamp: () => Math.floor(Date.now() / 1000) - 5,
      expectedCalls: 1,
    },
    {
      name: "delivery coordinator skips stale append messages",
      id: "stale-1",
      body: "old history sync",
      remoteJid: "120363@g.us",
      type: "append" as const,
      timestamp: () => Math.floor(Date.now() / 1000) - 300,
      expectedCalls: 0,
    },
    {
      name: "delivery coordinator skips append messages with non-finite timestamps",
      id: "nan-1",
      body: "bad timestamp",
      remoteJid: "120363@g.us",
      type: "append" as const,
      timestamp: () => Number.NaN,
      expectedCalls: 0,
    },
    {
      name: "delivery coordinator skips append messages with non-decimal timestamps",
      id: "hex-1",
      body: "hex timestamp",
      remoteJid: "120363@g.us",
      type: "append" as const,
      timestamp: () => {
        const recent = Math.floor(Date.now() / 1000) - 5;
        return `0x${recent.toString(16)}`;
      },
      expectedCalls: 0,
    },
    {
      name: "delivery coordinator handles Long-like protobuf timestamps",
      id: "long-1",
      body: "long timestamp",
      remoteJid: "120363@g.us",
      type: "append" as const,
      timestamp: () => {
        const recent = Math.floor(Date.now() / 1000) - 5;
        return { low: recent, high: 0, unsigned: true, valueOf: () => recent };
      },
      expectedCalls: 1,
    },
    {
      name: "delivery coordinator always processes notify messages",
      id: "notify-1",
      body: "normal message",
      remoteJid: "999@s.whatsapp.net",
      type: "notify" as const,
      timestamp: () => Math.floor(Date.now() / 1000) - 86_400,
      expectedCalls: 1,
    },
  ])("$name", async ({ id, body, remoteJid, type, timestamp, expectedCalls }) => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    emitUpsert(sock, { id, body, remoteJid, type, timestamp: timestamp() });
    if (expectedCalls === 1) {
      await waitForMessageCalls(onMessage, 1);
    } else {
      await settleInboundWork();
    }

    expect(onMessage).toHaveBeenCalledTimes(expectedCalls);
    await listener.close();
  });

  it("delivery coordinator limits reconnect catch-up appends by dedupe age", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      appendReplyWindow: {
        afterMs: Date.now() - 30 * 60_000,
        untilMs: Date.now() + 30 * 60_000,
        maxAgeMs: 20 * 60_000,
      },
    });

    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "catch-up-1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "missed while reconnecting" },
          messageTimestamp: Math.floor(Date.now() / 1000) - 15 * 60,
          pushName: "Reconnect Tester",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "catch-up-old", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "before the recovery window" },
          messageTimestamp: Math.floor(Date.now() / 1000) - 25 * 60,
          pushName: "Reconnect Tester",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator preserves fresh appends after catch-up expires", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      appendReplyWindow: {
        afterMs: Date.now() - 30 * 60_000,
        untilMs: Date.now() - 1,
        maxAgeMs: 20 * 60_000,
      },
    });

    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "catch-up-late", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "arrived after recovery" },
          messageTimestamp: Math.floor(Date.now() / 1000) - 5 * 60,
          pushName: "Reconnect Tester",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "fresh-after-catch-up", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "fresh after recovery" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          pushName: "Reconnect Tester",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator processes distinct catch-up messages at the boundary", async () => {
    // Baileys timestamps use whole seconds. Freeze this inclusive boundary so
    // async monitor startup cannot age the fixture beyond maxAgeMs.
    const nowMs = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const onMessage = vi.fn(async () => {});
      const boundarySeconds = nowMs / 1000 - 20 * 60;
      const { listener, sock } = await startInboxMonitor(onMessage, {
        appendReplyWindow: {
          afterMs: boundarySeconds * 1000,
          untilMs: nowMs + 30 * 60_000,
          maxAgeMs: 20 * 60_000,
        },
      });
      try {
        sock.ev.emit("messages.upsert", {
          type: "append",
          messages: [
            {
              key: {
                id: "catch-up-same-second",
                fromMe: false,
                remoteJid: "999@s.whatsapp.net",
              },
              message: { conversation: "same second, different message" },
              messageTimestamp: boundarySeconds,
              pushName: "Reconnect Tester",
            },
          ],
        });
        await waitForMessageCalls(onMessage, 1);

        expect(onMessage).toHaveBeenCalledTimes(1);
      } finally {
        await listener.close();
      }
    } finally {
      dateNow.mockRestore();
    }
  });

  it("delivery coordinator answers an offline append after a cold start", async () => {
    writeSyncedCreds(3);
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    emitUpsert(sock, {
      id: "cold-start-inside",
      body: "sent while the gateway was down",
      remoteJid: "999@s.whatsapp.net",
      type: "append",
      timestamp: Math.floor(Date.now() / 1000) - 5 * 60,
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    await listener.close();
  });

  it("delivery coordinator drops a cold-start append past the catch-up ceiling", async () => {
    writeSyncedCreds(3);
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    emitUpsert(sock, {
      id: "cold-start-outside",
      body: "older than the catch-up ceiling",
      remoteJid: "999@s.whatsapp.net",
      type: "append",
      timestamp: Math.floor(Date.now() / 1000) - 25 * 60,
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
  });

  it("delivery coordinator drops replayed history for a session awaiting its first sync", async () => {
    writeSyncedCreds(0);
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    emitUpsert(sock, {
      id: "first-link-history",
      body: "predates the pairing",
      remoteJid: "999@s.whatsapp.net",
      type: "append",
      timestamp: Math.floor(Date.now() / 1000) - 5 * 60,
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
  });
});
