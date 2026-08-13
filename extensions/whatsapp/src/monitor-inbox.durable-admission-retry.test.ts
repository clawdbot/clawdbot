// WhatsApp monitor inbox durable admission retry behavior.
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { WHATSAPP_INBOUND_ADMISSION_CUSTODY_LIMIT } from "./inbound/admission-retry.js";
import { createWhatsAppDurableInboundQueue } from "./inbound/durable-receive.js";
import {
  inboundMessage,
  installStreamsInboundMessageHooks,
  nextMessageId,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  DEFAULT_ACCOUNT_ID,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

function createFlakyDurableInboundQueue(failedAttempts: number) {
  const realQueue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
  const attempts = { count: 0 };
  const queue: typeof realQueue = {
    ...realQueue,
    enqueue: async (eventId, payload, options) => {
      attempts.count += 1;
      if (attempts.count <= failedAttempts) {
        throw new Error("sqlite unavailable");
      }
      return realQueue.enqueue(eventId, payload, options);
    },
  };
  return { queue, attempts };
}

describe("web monitor inbox durable admission retry", () => {
  installStreamsInboundMessageHooks();

  it("readmits the inbound message after transient durable append failure", async () => {
    const { queue, attempts } = createFlakyDurableInboundQueue(3);
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      durableInboundQueue: queue,
    });

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("admission-retry"),
        remoteJid: "999@s.whatsapp.net",
        text: "survives storage outage",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );

    await waitForMessageCalls(onMessage, 1);
    expect(attempts.count).toBeGreaterThanOrEqual(4);
    expect(inboundMessage(onMessage).payload.body).toBe("survives storage outage");
    await listener.close();
  });

  it("abandons admission retries when the inbound coordinator closes", async () => {
    const { queue, attempts } = createFlakyDurableInboundQueue(Number.POSITIVE_INFINITY);
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      durableInboundQueue: queue,
    });

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("admission-abandon"),
        remoteJid: "999@s.whatsapp.net",
        text: "storage never recovers",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );

    await vi.waitFor(() => {
      expect(attempts.count).toBeGreaterThanOrEqual(3);
    });
    await listener.close();
    const attemptsAfterClose = attempts.count;
    await delay(1_500);
    expect(attempts.count).toBe(attemptsAfterClose);
    expect(onMessage).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps same-chat arrival order while an earlier admission is still retrying", async () => {
    const { queue } = createFlakyDurableInboundQueue(3);
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      durableInboundQueue: queue,
    });

    for (const text of ["first arrival", "second arrival"]) {
      sock.ev.emit(
        "messages.upsert",
        buildNotifyMessageUpsert({
          id: nextMessageId("admission-order"),
          remoteJid: "998@s.whatsapp.net",
          text,
          timestamp: 1_700_000_000,
          pushName: "Tester",
        }),
      );
    }

    await waitForMessageCalls(onMessage, 2);
    expect([
      inboundMessage(onMessage, 0).payload.body,
      inboundMessage(onMessage, 1).payload.body,
    ]).toEqual(["first arrival", "second arrival"]);
    await listener.close();
  }, 20_000);

  it("counts every message of one upsert batch against the admission custody limit", async () => {
    const { queue, attempts } = createFlakyDurableInboundQueue(Number.POSITIVE_INFINITY);
    const logPath = path.join(os.tmpdir(), `openclaw-admission-custody-${randomUUID()}.log`);
    setLoggerOverride({ level: "trace", file: logPath });
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      durableInboundQueue: queue,
    });

    const batched: Array<unknown> = [];
    for (let index = 0; index < WHATSAPP_INBOUND_ADMISSION_CUSTODY_LIMIT; index += 1) {
      batched.push(
        ...buildNotifyMessageUpsert({
          id: nextMessageId("admission-custody"),
          remoteJid: "997@s.whatsapp.net",
          text: `batched ${index}`,
          timestamp: 1_700_000_000,
          pushName: "Tester",
        }).messages,
      );
    }
    sock.ev.emit("messages.upsert", { type: "notify", messages: batched });
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("admission-custody"),
        remoteJid: "997@s.whatsapp.net",
        text: "arrival past the limit",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );

    await vi.waitFor(
      async () => {
        const logged = await readFile(logPath, "utf8").catch(() => "");
        expect(logged).toContain(
          `custody limit of ${WHATSAPP_INBOUND_ADMISSION_CUSTODY_LIMIT} inbound messages reached`,
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(attempts.count).toBeLessThan(WHATSAPP_INBOUND_ADMISSION_CUSTODY_LIMIT);
    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
    resetLogger();
    setLoggerOverride(null);
    await rm(logPath, { force: true });
  }, 20_000);
});
