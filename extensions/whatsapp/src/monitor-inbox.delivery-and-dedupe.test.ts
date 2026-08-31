// WhatsApp monitor inbox behavior split by ownership.
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppDurableInboundQueue } from "./inbound/durable-receive.js";
import { resolveWhatsAppIngressLifecycle } from "./inbound/ingress-lifecycle.js";
import type { WebInboundMessage } from "./inbound/types.js";
import {
  nextMessageId,
  inboundMessage,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  DEFAULT_ACCOUNT_ID,
  resetWebInboundDedupeForTests,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox delivery and dedupe", () => {
  installStreamsInboundMessageHooks();

  it("delivery coordinator streams inbound messages", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.platform.sendComposing();
      await msg.platform.reply("nested reply works");
      await msg.platform.sendMedia({ text: "nested media works" });
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    expect(sock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "available");
    const messageId = nextMessageId("stream");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.platform.recipientJid).toBe("+123");
    expect(inbound.admission).toMatchObject({
      accountId: DEFAULT_ACCOUNT_ID,
      conversation: {
        kind: "direct",
        id: "+999",
      },
      sender: {
        id: "+999",
      },
      senderAccess: {
        allowed: true,
        decision: "allow",
      },
    });
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: messageId,
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("composing", "999@s.whatsapp.net");
    expect(sock.sendMessage).toHaveBeenNthCalledWith(1, "999@s.whatsapp.net", {
      text: "nested reply works",
    });
    expect(sock.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
      text: "nested media works",
    });

    await listener.close();
  });

  it("delivery coordinator delays read receipts until inbound handlers complete", async () => {
    let finishMessage: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      finishMessage = resolve;
    });
    const onMessage = vi.fn(async () => {
      await handlerGate;
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const messageId = nextMessageId("delayed-read");

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: messageId,
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    expect(sock.readMessages).not.toHaveBeenCalled();
    finishMessage?.();
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledWith([
        {
          remoteJid: "999@s.whatsapp.net",
          id: messageId,
          participant: undefined,
          fromMe: false,
        },
      ]);
    });

    await listener.close();
  });

  it("delivery coordinator keeps the first durable delivery when a duplicate arrives", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const messageId = nextMessageId("dup-prepared");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "first",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    // Duplicate delivery of the same message id stays pending behind the first claim.
    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await settleInboundWork();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(inboundMessage(onMessage).payload.body).toBe("first");
    await listener.close();
  });

  it("delivery coordinator retries a transient persistence failure through the drain", async () => {
    const onMessage = vi.fn(async () => undefined);
    const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
    // One transient rejection absorbs into the bounded retry; the message then
    // flows durably. The retired live-dispatch fallback is gone: it bypassed
    // drain dedupe and lane serialization once the replay guard was deleted.
    const durableInboundQueue = {
      ...queue,
      // First attempt rejects; the bounded retry's second attempt must reach
      // the real queue so the message flows durably.
      enqueue: vi.fn(queue.enqueue.bind(queue)).mockRejectedValueOnce(new Error("SQLITE_FULL")),
    };

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      durableInboundQueue,
    });
    const messageId = nextMessageId("durable-fallback");

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: messageId,
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    expect(inboundMessage(onMessage).payload.body).toBe("ping");
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledWith([
        {
          remoteJid: "999@s.whatsapp.net",
          id: messageId,
          participant: undefined,
          fromMe: false,
        },
      ]);
    });

    await listener.close();
  });

  it("delivery coordinator does not dispatch duplicates with pending durable delivery", async () => {
    let finishMessage: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      finishMessage = resolve;
    });
    const onMessage = vi.fn(async () => {
      await handlerGate;
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const messageId = nextMessageId("durable-pending");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    resetWebInboundDedupeForTests();
    sock.ev.emit("messages.upsert", upsert);
    await settleInboundWork();
    expect(onMessage).toHaveBeenCalledTimes(1);

    finishMessage?.();
    await listener.close();
  });

  it("delivery coordinator does not redispatch a completed transport-key duplicate", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("durable-completed"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));
    sock.readMessages.mockClear();

    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));

    expect(onMessage).toHaveBeenCalledTimes(1);
    await listener.close();
  });

  it("delivery coordinator lets a later same-key flush steer during an active turn", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onMessage = vi.fn(async (message: WebInboundMessage) => {
      const lifecycle = resolveWhatsAppIngressLifecycle(message);
      if (!lifecycle) {
        throw new Error("expected durable ingress lifecycle");
      }
      await lifecycle.onAdopted();
      if (onMessage.mock.calls.length === 1) {
        await firstTurn;
      }
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 20,
    });
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("debounce-steer-1"),
        remoteJid: "999@s.whatsapp.net",
        text: "first",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);
    expect(inboundMessage(onMessage).payload.body).toBe("first");

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("debounce-steer-2"),
        remoteJid: "999@s.whatsapp.net",
        text: "steer",
        timestamp: 1_700_000_001,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 2);
    expect(inboundMessage(onMessage, 1).payload.body).toBe("steer");

    releaseFirst?.();
    await listener.close();
  });

  it("delivery coordinator drains admitted same-lane turns before close completes", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onMessage = vi.fn(async (message: WebInboundMessage) => {
      const lifecycle = resolveWhatsAppIngressLifecycle(message);
      if (!lifecycle) {
        throw new Error("expected durable ingress lifecycle");
      }
      await lifecycle.onAdopted();
      if (onMessage.mock.calls.length === 1) {
        await firstTurn;
      }
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 20,
    });
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("debounce-close-1"),
        remoteJid: "999@s.whatsapp.net",
        text: "first",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    const second = buildNotifyMessageUpsert({
      id: nextMessageId("debounce-close-2"),
      remoteJid: "999@s.whatsapp.net",
      text: "second",
      timestamp: 1_700_000_001,
      pushName: "Tester",
    });
    const third = buildNotifyMessageUpsert({
      id: nextMessageId("debounce-close-3"),
      remoteJid: "999@s.whatsapp.net",
      text: "third",
      timestamp: 1_700_000_002,
      pushName: "Tester",
    });
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [...second.messages, ...third.messages],
    });

    let closed = false;
    const closePromise = listener.close().then(() => {
      closed = true;
    });
    await waitForMessageCalls(onMessage, 3);
    expect(closed).toBe(false);
    expect(inboundMessage(onMessage, 1).payload.body).toBe("second");
    expect(inboundMessage(onMessage, 2).payload.body).toBe("third");

    releaseFirst?.();
    await closePromise;
    expect(closed).toBe(true);
  });

  it("delivery coordinator keeps a reused debounce key pending across turns", async () => {
    let releaseFirst!: () => void;
    let finishFirst!: () => void;
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const onMessage = vi.fn(async (message: WebInboundMessage) => {
      const lifecycle = resolveWhatsAppIngressLifecycle(message);
      if (!lifecycle) {
        throw new Error("expected durable ingress lifecycle");
      }
      await lifecycle.onAdopted();
      if (onMessage.mock.calls.length === 1) {
        await firstTurn;
        finishFirst();
      }
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 60_000,
      shouldDebounce: (message) => message.payload.body !== "first",
    });
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("debounce-reused-key-1"),
        remoteJid: "999@s.whatsapp.net",
        text: "first",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("debounce-reused-key-2"),
        remoteJid: "999@s.whatsapp.net",
        text: "second",
        timestamp: 1_700_000_001,
        pushName: "Tester",
      }),
    );
    await settleInboundWork();
    expect(onMessage).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstFinished;
    await settleInboundWork();

    const closeStarted = Date.now();
    await listener.close();
    expect(Date.now() - closeStarted).toBeLessThan(5_000);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(inboundMessage(onMessage, 1).payload.body).toBe("second");
  });

  it("delivery coordinator force-flushes long durable debounce during shutdown", async () => {
    // Durable pump tasks await claim flush waiters; close must force-flush
    // debounced batches before waiting on those pumps (socket-close timeout).
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 60_000,
    });
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("debounce-shutdown-durable"),
        remoteJid: "999@s.whatsapp.net",
        text: "held in debounce",
        timestamp: 1_700_000_100,
        pushName: "Tester",
      }),
    );
    // Let accept+pump reach the flush waiter without exhausting the debounce window.
    await settleInboundWork();

    const closeStarted = Date.now();
    await listener.close();
    const closeElapsedMs = Date.now() - closeStarted;

    expect(closeElapsedMs).toBeLessThan(5_000);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(inboundMessage(onMessage).payload.body).toBe("held in debounce");
    expect(sock.end).toHaveBeenCalledTimes(1);
  });

  it("delivery coordinator drains serialized same-lane replies before socket close", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (() => void) | undefined;
      const firstTurn = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const onMessage = vi.fn(async (msg) => {
        await msg.platform.reply("pong");
        await msg.platform.sendMedia({ text: "media" });
        if (onMessage.mock.calls.length === 1) {
          await firstTurn;
        }
      });
      const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
        debounceMs: 50,
      });
      sock.ev.emit(
        "messages.upsert",
        buildNotifyMessageUpsert({
          id: nextMessageId("debounce-close-reply-1"),
          remoteJid: "999@s.whatsapp.net",
          text: "first",
          timestamp: 1_700_000_000,
          pushName: "Tester",
        }),
      );
      await vi.advanceTimersByTimeAsync(50);
      await waitForMessageCalls(onMessage, 1);
      expect(inboundMessage(onMessage).payload.body).toBe("first");

      sock.ev.emit(
        "messages.upsert",
        buildNotifyMessageUpsert({
          id: nextMessageId("debounce-close-reply-2"),
          remoteJid: "999@s.whatsapp.net",
          text: "second",
          timestamp: 1_700_000_001,
          pushName: "Tester",
        }),
      );

      const closePromise = listener.close();
      expect(onMessage).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await closePromise;

      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(inboundMessage(onMessage, 1).payload.body).toBe("second");
      expect(sock.sendMessage).toHaveBeenNthCalledWith(1, "999@s.whatsapp.net", {
        text: "pong",
      });
      expect(sock.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
        text: "media",
      });
      expect(sock.sendMessage).toHaveBeenNthCalledWith(3, "999@s.whatsapp.net", {
        text: "pong",
      });
      expect(sock.sendMessage).toHaveBeenNthCalledWith(4, "999@s.whatsapp.net", {
        text: "media",
      });
      expect(sock.end).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(
        sock.end.mock.invocationCallOrder.at(0),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivery coordinator waits for in-flight handlers before close drain", async () => {
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const onMessage = vi.fn(async (msg) => {
      await msg.platform.reply("pong");
      markHandlerStarted?.();
      await handlerGate;
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("close-inflight"),
        remoteJid: "999@s.whatsapp.net",
        text: "first",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );

    await handlerStarted;
    const closePromise = listener.close();
    await Promise.resolve();

    expect(sock.end).not.toHaveBeenCalled();

    if (!releaseHandler) {
      throw new Error("Expected handler release callback to be initialized");
    }
    releaseHandler();
    await closePromise;

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });
    expect(sock.end).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage.mock.invocationCallOrder.at(0)).toBeLessThan(
      sock.end.mock.invocationCallOrder.at(0),
    );
  });

  it("delivery coordinator deduplicates redelivered messages by id", async () => {
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("dedupe"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator dispatches same-content messages with distinct ids in order", async () => {
    const onMessage = vi.fn(async (_message: WebInboundMessage) => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    for (const [index, id] of ["in-2", "in-3"].entries()) {
      sock.ev.emit(
        "messages.upsert",
        buildNotifyMessageUpsert({
          id,
          remoteJid: "999@s.whatsapp.net",
          text: "Done.",
          timestamp: 1_700_000_000 + index,
          pushName: "Tester",
        }),
      );
      await waitForMessageCalls(onMessage, index + 1);
    }

    expect(onMessage.mock.calls.map(([message]) => message.event.id)).toEqual(["in-2", "in-3"]);
    await listener.close();
  });

  it("delivery coordinator automatically retries after an explicit retryable failure", async () => {
    let attempts = 0;
    const onMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        // Any non-permanent error is retryable to the drain classifier.
        throw new Error("retry me");
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("retryable-dedupe"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledTimes(1);
    });

    await listener.close();
  });

  it("delivery coordinator automatically retries after reply session conflicts", async () => {
    let attempts = 0;
    const onMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "reply session initialization conflicted for agent:main:whatsapp:direct:+15551234567",
        );
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("session-init-conflict"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledTimes(1);
    });

    await listener.close();
  });

  it("delivery coordinator keeps same-lane follow-up pending until turn adoption", async () => {
    let adoptFirst: (() => void | Promise<void>) | undefined;
    const onMessage = vi.fn(async (message: WebInboundMessage) => {
      if (!adoptFirst) {
        const lifecycle = resolveWhatsAppIngressLifecycle(message);
        if (!lifecycle) {
          throw new Error("expected durable ingress lifecycle");
        }
        lifecycle.onDeferred();
        adoptFirst = lifecycle.onAdopted;
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "abc1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "abc2", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "pong" },
          messageTimestamp: 1_700_000_001,
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(inboundMessage(onMessage).payload.body).toBe("ping");

    if (!adoptFirst) {
      throw new Error("expected first adoption callback");
    }
    await adoptFirst();
    await waitForMessageCalls(onMessage, 2);
    expect(inboundMessage(onMessage, 1).payload.body).toBe("pong");
    await listener.close();
  });
});
