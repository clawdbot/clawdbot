// WhatsApp receive-time read-receipt retry for active durable duplicates.
// While a durable row stays pending or claimed, the admission verdict has no
// accepted branch, so a replay is the only path that can re-reach the receipt
// dispatcher after a failed first attempt.
import { describe, expect, it, vi } from "vitest";
import { nextMessageId } from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox receipt retry", () => {
  installWebMonitorInboxUnitTestHooks();

  it("delivery coordinator retries a rejected receipt for a pending durable duplicate without redelivering the turn", async () => {
    // While the first same-lane turn stays active, the lane stays blocked, so
    // the second message's durable row remains pending (never claimed). Its
    // receive-time receipt rejects; a replay of the same transport key must
    // retry the receipt through the dispatcher even though the durable row is
    // still pending — and must not redeliver the agent turn.
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const onMessage = vi.fn(async () => {
      await turnGate;
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    const blockerId = nextMessageId("receipt-pending-blocker");
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: blockerId,
        remoteJid: "999@s.whatsapp.net",
        text: "blocker",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));

    const messageId = nextMessageId("receipt-pending-reject");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_001,
      pushName: "Tester",
    });

    // The receive-time acknowledgement rejects; the failed attempt releases
    // its dispatcher reservation without recording success.
    sock.readMessages.mockRejectedValueOnce(new Error("connection closed"));

    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));
    await settleInboundWork();

    // Replay the same transport key while the durable row is still pending:
    // the receipt must retry through the dispatcher, and the agent turn must
    // not redeliver.
    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(3));

    expect(onMessage).toHaveBeenCalledTimes(1);

    releaseTurn?.();
    await listener.close();
  });

  it("delivery coordinator retries a rejected receipt for a claimed durable duplicate without redelivering the turn", async () => {
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const onMessage = vi.fn(async () => {
      await turnGate;
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const messageId = nextMessageId("receipt-claimed-reject");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    // The receive-time acknowledgement rejects on the socket while the agent
    // turn is still active, so the durable row stays claimed.
    sock.readMessages.mockRejectedValueOnce(new Error("connection closed"));

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));
    await settleInboundWork();

    // Replay while the original durable row is still claimed: the receipt
    // must retry through the dispatcher and the turn must not redeliver.
    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));

    expect(onMessage).toHaveBeenCalledTimes(1);

    releaseTurn?.();
    await listener.close();
  });

  it("delivery coordinator retries a timed-out receipt for a claimed durable duplicate without redelivering the turn", async () => {
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const onMessage = vi.fn(async () => {
      await turnGate;
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      socketTiming: {
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 100,
      },
    });
    const messageId = nextMessageId("receipt-claimed-timeout");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    // The receive-time acknowledgement stalls on the socket and trips the
    // owned operation timeout while the agent turn keeps the row claimed.
    sock.readMessages.mockImplementationOnce(() => new Promise<never>(() => {}));

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));
    // Let the operation timeout fire and release the in-flight reservation.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    // Replay while the original durable row is still claimed: the receipt
    // must retry through the dispatcher and the turn must not redeliver.
    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));

    expect(onMessage).toHaveBeenCalledTimes(1);

    releaseTurn?.();
    await listener.close();
  });

  it("delivery coordinator retries a timed-out receipt for a pending durable duplicate without redelivering the turn", async () => {
    // Mirrors the pending-duplicate rejection case: the first same-lane turn
    // keeps the lane blocked, so the second message's durable row remains
    // pending. Its receive-time receipt times out; a replay must retry the
    // receipt through the dispatcher without redelivering the agent turn.
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const onMessage = vi.fn(async () => {
      await turnGate;
    });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      socketTiming: {
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 100,
      },
    });

    const blockerId = nextMessageId("receipt-pending-timeout-blocker");
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: blockerId,
        remoteJid: "999@s.whatsapp.net",
        text: "blocker",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(1));

    const messageId = nextMessageId("receipt-pending-timeout");
    const upsert = buildNotifyMessageUpsert({
      id: messageId,
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_001,
      pushName: "Tester",
    });

    // The receive-time acknowledgement stalls on the socket and trips the
    // owned operation timeout while the durable row stays pending.
    sock.readMessages.mockImplementationOnce(() => new Promise<never>(() => {}));

    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(2));
    // Let the operation timeout fire and release the in-flight reservation.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    // Replay the same transport key while the durable row is still pending:
    // the receipt must retry through the dispatcher, and the agent turn must
    // not redeliver.
    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(() => expect(sock.readMessages).toHaveBeenCalledTimes(3));

    expect(onMessage).toHaveBeenCalledTimes(1);

    releaseTurn?.();
    await listener.close();
  });
});
