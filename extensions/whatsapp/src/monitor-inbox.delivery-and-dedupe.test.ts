// WhatsApp monitor inbox behavior split by ownership.
import { createHash } from "node:crypto";
import type { WAMessage } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { serializeWhatsAppDurableInboundMessage } from "./inbound/durable-payload.js";
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

  it("delivery coordinator sends read receipts when the message is received, not after the agent turn", async () => {
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let markHandlerFinished: (() => void) | undefined;
    const handlerFinished = new Promise<void>((resolve) => {
      markHandlerFinished = resolve;
    });
    const onMessage = vi.fn(async () => {
      await handlerGate;
      markHandlerFinished?.();
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const messageId = nextMessageId("immediate-read");

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

    // The read receipt (blue tick) must already be on the wire while the
    // agent turn is still running — the handler gate is still closed.
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: messageId,
        participant: undefined,
        fromMe: false,
      },
    ]);

    releaseHandler?.();
    await handlerFinished;
    await settleInboundWork();

    // Completing the turn must not send a second receipt.
    expect(sock.readMessages).toHaveBeenCalledTimes(1);

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
    // The pending redelivery must not re-send the receive-time receipt.
    expect(sock.readMessages).toHaveBeenCalledTimes(1);

    finishMessage?.();
    await listener.close();
  });

  it("delivery coordinator does not re-send the read receipt for a completed transport-key duplicate", async () => {
    const onMessage = vi.fn(async () => undefined);
    const pendingWork = vi.fn<(count: number, at?: number) => void>();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      onPendingWorkChanged: pendingWork,
    });
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

    // Redelivery of the completed transport key must not send a second
    // receipt: the receive-time receipt already fired on acceptance.
    const settledBefore = pendingWork.mock.calls.length;
    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => {
      expect(pendingWork.mock.calls.length).toBeGreaterThan(settledBefore);
      expect(pendingWork.mock.calls.at(-1)?.[0]).toBe(0);
    });

    expect(sock.readMessages).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    await listener.close();
  });

  it("delivery coordinator retries a rejected read receipt when the message is redelivered", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const messageId = nextMessageId("receipt-rejection-retry");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    // The receive-time acknowledgement fails on the socket; the failed
    // attempt must release its reservation instead of claiming the receipt
    // permanently.
    sock.readMessages.mockRejectedValueOnce(new Error("connection closed"));

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));

    // A same-process redelivery of the completed transport key retries the
    // missing receipt.
    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));

    // The message itself stays deduped; only the receipt is retried.
    expect(onMessage).toHaveBeenCalledTimes(1);
    await listener.close();
  });

  it("delivery coordinator retries a timed-out read receipt when the message is redelivered", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      socketTiming: {
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 100,
      },
    });
    const messageId = nextMessageId("receipt-timeout-retry");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    // The receive-time acknowledgement stalls on the socket and trips the
    // owned operation timeout.
    sock.readMessages.mockImplementationOnce(() => new Promise<never>(() => {}));

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));
    // Let the operation timeout fire and release the in-flight reservation.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    // A same-process redelivery of the completed transport key retries the
    // missing receipt.
    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));

    expect(onMessage).toHaveBeenCalledTimes(1);
    await listener.close();
  });

  it("delivery coordinator does not block later message admission on a stalled read receipt", async () => {
    let releaseFirstReceipt: (() => void) | undefined;
    let firstReceiptSettled = false;
    const firstReceiptGate = new Promise<void>((resolve) => {
      releaseFirstReceipt = resolve;
    });
    void firstReceiptGate.then(() => {
      firstReceiptSettled = true;
    });
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 20,
      // The receive-time receipt for the first message stalls on the socket.
      // It is bounded by the socket operation timeout, but the admission loop
      // must not wait for it: the second message in the same upsert has to be
      // admitted while the first receipt is still in flight.
      socketTiming: {
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
      },
    });
    const firstId = nextMessageId("receipt-stall-1");
    const secondId = nextMessageId("receipt-stall-2");
    const first = buildNotifyMessageUpsert({
      id: firstId,
      remoteJid: "999@s.whatsapp.net",
      text: "first",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });
    const second = buildNotifyMessageUpsert({
      id: secondId,
      remoteJid: "999@s.whatsapp.net",
      text: "second",
      timestamp: 1_700_000_001,
      pushName: "Tester",
    });

    // Only the first receipt stalls; later receipts resolve normally.
    sock.readMessages.mockImplementationOnce(() => firstReceiptGate);

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [...first.messages, ...second.messages],
    });

    // Both messages are admitted and delivered while the first receipt is
    // still stalled on the socket.
    await waitForMessageCalls(onMessage, 2);
    expect(inboundMessage(onMessage, 0).payload.body).toBe("first");
    expect(inboundMessage(onMessage, 1).payload.body).toBe("second");
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: firstId,
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(firstReceiptSettled).toBe(false);

    // Release the stalled receipt; each message must still have exactly one
    // acknowledgement (no double-fire).
    releaseFirstReceipt?.();
    await vi.waitFor(() => expect(firstReceiptSettled).toBe(true));
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));
    expect(sock.readMessages).toHaveBeenNthCalledWith(1, [
      {
        remoteJid: "999@s.whatsapp.net",
        id: firstId,
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.readMessages).toHaveBeenNthCalledWith(2, [
      {
        remoteJid: "999@s.whatsapp.net",
        id: secondId,
        participant: undefined,
        fromMe: false,
      },
    ]);

    await listener.close();
  });

  it("delivery coordinator bounds concurrent read-receipt dispatches and drains queued receipts when the socket recovers", async () => {
    // Mirrors the production READ_RECEIPT_INFLIGHT_MAX /
    // READ_RECEIPT_PENDING_MAX bounds in inbound/message-delivery.ts. Each
    // distinct inbound message normally starts one socket readMessages
    // operation; when the socket is stalled (markRead is bounded by the
    // socket operation timeout, default 60s), a burst of distinct messages
    // must not start unbounded socket work, and receipts that arrive while
    // the in-flight window is full must be retained (queued) and drained
    // once the socket recovers — never silently dropped — while admission
    // stays unblocked and every message is acknowledged exactly once.
    const INFLIGHT_MAX = 32;
    const TOTAL = INFLIGHT_MAX + 3;
    const stalledAcks: Array<() => void> = [];
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 20,
      socketTiming: {
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
      },
      verbose: true,
    });

    const messages = Array.from(
      { length: TOTAL },
      (_, index) =>
        buildNotifyMessageUpsert({
          id: nextMessageId(`receipt-saturation-${index}`),
          remoteJid: "999@s.whatsapp.net",
          text: `msg-${index}`,
          timestamp: 1_700_000_000 + index,
          pushName: "Tester",
        }).messages[0],
    );

    // Every acknowledgement stalls on the socket, so the in-flight window
    // fills up and stays full.
    sock.readMessages.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stalledAcks.push(resolve);
        }),
    );

    sock.ev.emit("messages.upsert", { type: "notify", messages });

    // Admission is never blocked by receipt saturation: every message is
    // delivered even while the acknowledgement window is full.
    await waitForMessageCalls(onMessage, TOTAL);
    // Socket work is bounded to the in-flight window size while the socket
    // is stalled; the excess receipts are queued, not dropped.
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(INFLIGHT_MAX));
    expect(onMessage).toHaveBeenCalledTimes(TOTAL);

    // Recover the socket and release the stalled acknowledgements; the
    // queued receipts must drain automatically as the window frees up.
    sock.readMessages.mockResolvedValue(undefined);
    for (const release of stalledAcks.splice(0)) {
      release();
    }
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(TOTAL), {
      timeout: 5_000,
    });
    await settleInboundWork();

    // Every message is acknowledged exactly once: no receipt was silently
    // dropped during the stall and none double-fires after the drain.
    expect(sock.readMessages).toHaveBeenCalledTimes(TOTAL);

    // Redelivering an already-acknowledged message must not re-send its
    // receipt; the delivery itself stays deduped.
    sock.ev.emit("messages.upsert", { type: "notify", messages: [messages[INFLIGHT_MAX]] });
    await settleInboundWork();
    expect(sock.readMessages).toHaveBeenCalledTimes(TOTAL);
    expect(onMessage).toHaveBeenCalledTimes(TOTAL);

    await listener.close();
  });

  it("delivery coordinator bounds the pending receipt queue and keeps overflow retryable", async () => {
    // Beyond the in-flight window AND the bounded pending queue, a receipt
    // target can no longer be retained: it is dropped with a warn, but the
    // message itself is still admitted, and a redelivery retries the receipt
    // once capacity frees up — the loss is bounded and observable, never a
    // silent unbounded swallow.
    const INFLIGHT_MAX = 32;
    const PENDING_MAX = 128;
    const TOTAL = INFLIGHT_MAX + PENDING_MAX + 5;
    const RETAINED = INFLIGHT_MAX + PENDING_MAX;
    const stalledAcks: Array<() => void> = [];
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 20,
      socketTiming: {
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
      },
      verbose: true,
    });

    const messages = Array.from(
      { length: TOTAL },
      (_, index) =>
        buildNotifyMessageUpsert({
          id: nextMessageId(`receipt-queue-overflow-${index}`),
          remoteJid: "999@s.whatsapp.net",
          text: `msg-${index}`,
          timestamp: 1_700_000_000 + index,
          pushName: "Tester",
        }).messages[0],
    );

    sock.readMessages.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stalledAcks.push(resolve);
        }),
    );

    sock.ev.emit("messages.upsert", { type: "notify", messages });

    // Admission is never blocked: every message is delivered even when both
    // receipt windows are full. (Custom timeout: 165 messages through the
    // debounced admission pipeline exceed the shared helper's fixed 5s
    // window.)
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(TOTAL), {
      timeout: 20_000,
    });
    expect(sock.readMessages).toHaveBeenCalledTimes(INFLIGHT_MAX);

    // Recover the socket: the in-flight window drains, then the bounded
    // pending queue drains completely; only the beyond-bound overflow is
    // dropped.
    sock.readMessages.mockResolvedValue(undefined);
    for (const release of stalledAcks.splice(0)) {
      release();
    }
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(RETAINED), {
      timeout: 5_000,
    });
    await settleInboundWork();
    expect(sock.readMessages).toHaveBeenCalledTimes(RETAINED);

    // A dropped receipt was never recorded as sent: redelivering one of the
    // overflow messages retries its acknowledgement. The delivery itself
    // stays deduped: the agent still sees each message exactly once.
    const droppedIndex = RETAINED;
    sock.ev.emit("messages.upsert", { type: "notify", messages: [messages[droppedIndex]] });
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(RETAINED + 1), {
      timeout: 5_000,
    });
    expect(onMessage).toHaveBeenCalledTimes(TOTAL);

    await listener.close();
  });

  it("delivery coordinator acknowledges a completed duplicate replayed after restart once", async () => {
    const onMessage = vi.fn(async () => undefined);
    const first = await startInboxMonitor(onMessage as InboxOnMessage);
    const sock = first.sock;
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("durable-replay"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));
    await first.listener.close();

    // A fresh coordinator (simulated process restart) has no in-memory receipt
    // memo; the completed replay redelivery still acknowledges the message once.
    const replayedOnMessage = vi.fn(async () => undefined);
    const replay = await startInboxMonitor(replayedOnMessage as InboxOnMessage);
    replay.sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));
    await settleInboundWork();
    expect(replayedOnMessage).not.toHaveBeenCalled();
    await replay.listener.close();
  });

  it("delivery coordinator sends a read receipt for a cold durable replay drained at startup", async () => {
    // A stop after durable admission can leave a persisted row for the next
    // coordinator. Seed that row directly, then start a fresh coordinator:
    // its startup drain must dispatch the receive-time receipt even though no
    // new socket upsert ever arrives.
    const messageId = nextMessageId("cold-replay");
    const remoteJid = "999@s.whatsapp.net";
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid,
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });
    const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
    await queue.enqueue(
      createHash("sha256").update(`${remoteJid}\n${messageId}`).digest("hex"),
      {
        message: serializeWhatsAppDurableInboundMessage(upsert.messages[0] as unknown as WAMessage),
        upsertType: "notify",
        receivedAt: Date.now(),
      },
      { laneKey: remoteJid },
    );

    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      durableInboundQueue: queue,
    });
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid,
        id: messageId,
        participant: undefined,
        fromMe: false,
      },
    ]);
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

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await settleInboundWork();
    // Redelivery of the same message must not re-send the receipt.
    expect(sock.readMessages).toHaveBeenCalledTimes(1);

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

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await settleInboundWork();
    // Redelivery of the same message must not re-send the receipt.
    expect(sock.readMessages).toHaveBeenCalledTimes(1);

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
