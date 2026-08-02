// WhatsApp monitor inbox behavior split by ownership.
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import {
  controllerContexts,
  sleepWithAbortMock,
  nextMessageId,
  createSocketRef,
  fastReconnectPolicy,
  inboundMessage,
  expectSocketOperationTimeout,
  createBaileysCacheSupport,
  primeInboundReplyHandle,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  DEFAULT_ACCOUNT_ID,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxMonitorOptions,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";
import { lookupInboundMessageMeta } from "./quoted-message.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

describe("web monitor inbox socket lifecycle", () => {
  installStreamsInboundMessageHooks();

  it("socket session stays unavailable on connect in self-chat mode", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      selfChatMode: true,
    });

    expect(sock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "unavailable");

    await listener.close();
  });

  it("socket session uses a replacement socket for replies created before reconnect", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef: NonNullable<InboxMonitorOptions["socketRef"]> = { current: null };

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, { socketRef });
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("replacement-socket"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);

    const replacementSock = {
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    socketRef.current = replacementSock as unknown as NonNullable<
      InboxMonitorOptions["socketRef"]
    >["current"];

    await inbound.platform.reply("pong");
    await inbound.platform.sendMedia({ text: "after-reconnect" });
    await inbound.platform.sendComposing();

    expect(replacementSock.sendMessage).toHaveBeenNthCalledWith(1, "999@s.whatsapp.net", {
      text: "pong",
    });
    expect(replacementSock.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
      text: "after-reconnect",
    });
    expect(replacementSock.sendPresenceUpdate).toHaveBeenCalledWith(
      "composing",
      "999@s.whatsapp.net",
    );
    expect(sock.sendMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("socket session waits for a replacement socket before sending replies", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const { listener, sock, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      upsertId: "reconnect-gap",
      retryPolicy: {
        initialMs: 10,
        maxMs: 10,
        factor: 1,
        jitter: 0,
        maxAttempts: 2,
      },
    });

    const replacementSock = {
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    socketRef.current = null;
    sleepWithAbortMock.mockImplementationOnce(async () => {
      socketRef.current = replacementSock as unknown as NonNullable<
        InboxMonitorOptions["socketRef"]
      >["current"];
    });

    await inbound?.platform.reply("pong");

    expect(sleepWithAbortMock).toHaveBeenCalledWith(10, undefined);
    expect(replacementSock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });
    expect(sock.sendMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("socket session retries timed-out sends without clearing the socket ref", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const { listener, sock, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      upsertId: "timeout-retry",
      retryPolicy: fastReconnectPolicy(2),
    });

    sock.sendMessage
      .mockRejectedValueOnce(new Error("operation timed out"))
      .mockResolvedValueOnce({ key: { id: "after-timeout" } });

    await inbound?.platform.reply("pong");

    expect(sock.sendMessage).toHaveBeenNthCalledWith(1, "999@s.whatsapp.net", {
      text: "pong",
    });
    expect(sock.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
      text: "pong",
    });
    expect(socketRef.current).toBe(sock);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  type ReachoutTimelockCase = {
    name: string;
    fetchedStates?: Array<"active" | "inactive">;
    updatesBefore?: boolean[];
    preflight?: boolean;
    updateAfterPreflight?: boolean;
    target?: string;
    sends: Array<{ text: string; result: "resolve" | "reject" }>;
    expectedFetches: number;
    expectedSends: number;
  };

  const reachoutTimelockCases = [
    {
      name: "rejects direct sends while reachout timelock is active",
      fetchedStates: ["active"],
      sends: [{ text: "hello", result: "reject" }],
      expectedFetches: 1,
      expectedSends: 0,
    },
    {
      name: "uses connection updates before direct sends",
      updatesBefore: [true],
      sends: [{ text: "hello", result: "reject" }],
      expectedFetches: 0,
      expectedSends: 0,
    },
    {
      name: "allows direct sends after reachout timelock clears",
      updatesBefore: [true, false],
      sends: [{ text: "hello", result: "resolve" }],
      expectedFetches: 1,
      expectedSends: 1,
    },
    {
      name: "refreshes inactive reachout state before later direct sends",
      fetchedStates: ["inactive", "active"],
      sends: [
        { text: "first", result: "resolve" },
        { text: "second", result: "reject" },
      ],
      expectedFetches: 2,
      expectedSends: 1,
    },
    {
      name: "reuses readiness preflight for the immediate direct send",
      fetchedStates: ["inactive"],
      preflight: true,
      sends: [{ text: "hello", result: "resolve" }],
      expectedFetches: 1,
      expectedSends: 1,
    },
    {
      name: "invalidates readiness after an active timelock update",
      fetchedStates: ["inactive"],
      preflight: true,
      updateAfterPreflight: true,
      sends: [{ text: "hello", result: "reject" }],
      expectedFetches: 1,
      expectedSends: 0,
    },
    {
      name: "does not apply account reachout timelock to group sends",
      updatesBefore: [true],
      target: "120363401234567890@g.us",
      sends: [{ text: "hello", result: "resolve" }],
      expectedFetches: 0,
      expectedSends: 1,
    },
  ] satisfies ReachoutTimelockCase[];

  it.each(reachoutTimelockCases)("socket session $name", async (scenario) => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    for (const state of scenario.fetchedStates ?? []) {
      sock.fetchAccountReachoutTimelock.mockResolvedValueOnce(
        state === "active"
          ? {
              isActive: true,
              enforcementType: "WEB_COMPANION_ONLY",
              timeEnforcementEnds: new Date(Date.now() + 60_000),
            }
          : { isActive: false },
      );
    }
    for (const isActive of scenario.updatesBefore ?? []) {
      sock.ev.emit("connection.update", {
        reachoutTimeLock: {
          isActive,
          ...(isActive ? { enforcementType: "WEB_COMPANION_ONLY" } : {}),
        },
      });
    }

    try {
      const target = scenario.target ?? "+1555";
      if (scenario.preflight) {
        await listener.assertSendReady?.(target);
      }
      if (scenario.updateAfterPreflight) {
        sock.ev.emit("connection.update", {
          reachoutTimeLock: {
            isActive: true,
            enforcementType: "WEB_COMPANION_ONLY",
          },
        });
      }
      for (const send of scenario.sends) {
        const sendPromise = listener.sendMessage(target, send.text);
        if (send.result === "reject") {
          await expect(sendPromise).rejects.toThrow("WhatsApp reachout timelock is active");
        } else {
          await expect(sendPromise).resolves.toBeDefined();
          if (target.endsWith("@g.us")) {
            expect(sock.sendMessage).toHaveBeenCalledWith(target, { text: send.text });
          }
        }
      }

      expect(sock.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(scenario.expectedFetches);
      expect(sock.sendMessage).toHaveBeenCalledTimes(scenario.expectedSends);
    } finally {
      await listener.close();
    }
  });

  it("socket session blocks direct composing presence during reachout timelock", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const { listener, sock, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      upsertId: "reachout-composing",
      retryPolicy: fastReconnectPolicy(2),
    });
    sock.ev.emit("connection.update", {
      reachoutTimeLock: {
        isActive: true,
        enforcementType: "WEB_COMPANION_ONLY",
      },
    });
    sock.sendPresenceUpdate.mockClear();

    try {
      await inbound.platform.sendComposing();

      expect(sock.fetchAccountReachoutTimelock).not.toHaveBeenCalled();
      expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

  it("socket session times out stalled sends at the Baileys query timeout", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    vi.useFakeTimers();
    try {
      sock.sendMessage.mockImplementationOnce(() => new Promise(() => {}));

      const sendPromise = listener.sendMessage("+1555", "hello");
      await expectSocketOperationTimeout("sendMessage", sendPromise);
      expect(vi.getTimerCount()).toBe(0);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await listener.close();
    }
  });

  it("socket session preserves the socket after a local send timeout", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const { listener, sock, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      upsertId: "local-timeout-terminal",
      retryPolicy: fastReconnectPolicy(2),
    });
    vi.useFakeTimers();
    try {
      sock.sendMessage.mockImplementationOnce(() => new Promise(() => {}));

      const replyPromise = inbound.platform.reply("pong");
      await expectSocketOperationTimeout("sendMessage", replyPromise);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(socketRef.current).toBe(sock);
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await listener.close();
    }
  });

  it("socket session records outbound replies for Baileys retry lookup", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const baileysCache = createBaileysCacheSupport();
    const message = { conversation: "pong" };
    const { listener, sock, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      baileysCache,
      upsertId: "outbound-retry-cache",
      retryPolicy: fastReconnectPolicy(2),
    });
    sock.sendMessage.mockResolvedValueOnce({
      key: { id: "outbound-cached" },
      message,
    });

    await inbound.platform.reply("pong");

    await expect(
      baileysCache.socketOptions.getMessage({
        id: "outbound-cached",
        remoteJid: "999@s.whatsapp.net",
      }),
    ).resolves.toBe(message);
    expect(
      lookupInboundMessageMeta(DEFAULT_ACCOUNT_ID, "999@s.whatsapp.net", "outbound-cached"),
    ).toMatchObject({ fromMe: true, body: "pong" });

    await listener.close();
  });

  it("socket session suppresses self-echo after a late accepted send", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const baileysCache = createBaileysCacheSupport();
    const { listener, sock, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      baileysCache,
      upsertId: "late-accept",
      retryPolicy: fastReconnectPolicy(2),
    });
    const message = { conversation: "pong" };
    let acceptLateSend:
      | ((value: { key: { id: string }; message: { conversation: string } }) => void)
      | undefined;
    vi.useFakeTimers();
    try {
      sock.sendMessage.mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            acceptLateSend = resolve;
          }),
      );

      const replyPromise = inbound.platform.reply("pong");
      await expectSocketOperationTimeout("sendMessage", replyPromise);
    } finally {
      vi.useRealTimers();
    }

    acceptLateSend?.({ key: { id: "late-accepted" }, message });
    await settleInboundWork();
    await expect(
      baileysCache.socketOptions.getMessage({
        id: "late-accepted",
        remoteJid: "999@s.whatsapp.net",
      }),
    ).resolves.toBe(message);
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "late-accepted",
            fromMe: true,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "pong" },
          messageTimestamp: 1_700_000_001,
          pushName: "Tester",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(socketRef.current).toBe(sock);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();

    await listener.close();
  });

  it("socket session times out stalled send-api presence updates", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    vi.useFakeTimers();
    try {
      sock.sendPresenceUpdate.mockClear();
      sock.sendPresenceUpdate.mockImplementationOnce(() => new Promise(() => {}));

      const presencePromise = listener.sendComposingTo("+1555");
      await expectSocketOperationTimeout("sendPresenceUpdate", presencePromise);
      expect(sock.sendPresenceUpdate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await listener.close();
    }
  });

  it("socket session bounds stalled read-receipt operations", async () => {
    const onMessage = vi.fn(async () => undefined);
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      verbose: true,
    });
    vi.useFakeTimers();
    try {
      const messageId = nextMessageId("read-receipt-timeout");
      // A WhatsApp socket whose read-receipt acknowledgement never resolves
      // (e.g. a stalled Baileys privacy IQ query) would otherwise hang the
      // inbound delivery pipeline forever.
      sock.readMessages.mockImplementationOnce(() => new Promise(() => {}));

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

      // The read receipt is attempted on the stalled socket...
      await vi.waitFor(() => {
        expect(sock.readMessages).toHaveBeenCalledWith([
          { remoteJid: "999@s.whatsapp.net", id: messageId, participant: undefined, fromMe: false },
        ]);
      });

      // ...and is bounded by the socket operation timeout rather than hanging.
      await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
      await vi.waitFor(() => {
        const loggedTimeoutFailure = logSpy.mock.calls.some(
          ([message]) =>
            typeof message === "string" &&
            message.includes(`Failed to mark message ${messageId} read`) &&
            message.includes("readMessages timed out"),
        );
        expect(loggedTimeoutFailure).toBe(true);
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await listener.close();
      logSpy.mockRestore();
    }
  });

  it("socket session bounds reconnect-gap retries when attempts are unlimited", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const { listener, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      upsertId: "unlimited-reconnect-send-bound",
      retryPolicy: fastReconnectPolicy(0),
      useCurrentSock: true,
    });

    socketRef.current = null;

    await expect(inbound?.platform.reply("pong")).rejects.toThrow(
      "no active socket - reconnection in progress",
    );
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(11);

    await listener.close();
  });

  // VE-513: when the gateway's channel-health-monitor tears down controller A
  // mid-run (shutdown nulls A.socketRef and aborts A.disconnectRetries), then a
  // fresh controller B registers for the same accountId, an in-flight inbound's
  // captured reply closure must route through B's socket via the registry instead
  // of throwing RECONNECT_IN_PROGRESS. Before the registry fallback was added,
  // sendTrackedMessage only knew its own controller's socketRef and the captured
  // reply was permanently broken.

  it("socket session routes captured replies through a matching successor", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRefA = createSocketRef();

    let aShouldRetryDisconnect = true;
    const { listener: listenerA, sock: sockA } = await startInboxMonitor(
      onMessage as InboxOnMessage,
      {
        socketRef: socketRefA,
        shouldRetryDisconnect: () => aShouldRetryDisconnect,
        disconnectRetryPolicy: fastReconnectPolicy(1),
      },
    );

    sockA.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("outbound-successor"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);
    const inbound = inboundMessage(onMessage);

    // === Simulate health-monitor-driven shutdown of controller A ===
    socketRefA.current = null;
    aShouldRetryDisconnect = false;

    // The mock harness socket exposes user.id = "123@s.whatsapp.net"; the
    // successor must report an overlapping identity for the handoff to succeed.
    const sockB = {
      sendMessage: vi.fn(async () => ({ key: { id: "post-restart-msg-id" } })),
    };
    const handleB = {
      getActiveListener: () => null,
      getCurrentSock: () => sockB as never,
      getSelfIdentity: () => ({ jid: "123@s.whatsapp.net", lid: null }),
    } as never;
    controllerContexts.set(DEFAULT_ACCOUNT_ID, handleB);

    try {
      await inbound.reply("pong");
      await inbound.sendMedia({ text: "media after restart" });

      // Captured A reply routed through B via the runtime context.
      expect(sockB.sendMessage).toHaveBeenCalledTimes(2);
      expect(sockB.sendMessage).toHaveBeenNthCalledWith(1, "999@s.whatsapp.net", {
        text: "pong",
      });
      expect(sockB.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
        text: "media after restart",
      });
    } finally {
      controllerContexts.delete(DEFAULT_ACCOUNT_ID);
      await listenerA.close();
    }
  });

  // VE-513 PN/LID normalization: Baileys sockets may expose self identity in
  // different forms across reconnects (PN JID `<n>@s.whatsapp.net` vs LID
  // `<x>@lid`). The fallback must recognize the same account when one side
  // reports only PN and the other only LID, because the captured reply
  // shouldn't be dropped just because the identity form rotated.

  it("socket session accepts a successor with equivalent LID and phone identity", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRefA = createSocketRef();

    let aShouldRetryDisconnect = true;
    const { listener: listenerA, sock: sockA } = await startInboxMonitor(
      onMessage as InboxOnMessage,
      {
        socketRef: socketRefA,
        shouldRetryDisconnect: () => aShouldRetryDisconnect,
        disconnectRetryPolicy: fastReconnectPolicy(1),
      },
    );

    sockA.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("outbound-successor-lid"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);
    const inbound = inboundMessage(onMessage);

    socketRefA.current = null;
    aShouldRetryDisconnect = false;

    // The mock harness socket has user.id="123@s.whatsapp.net" (PN JID, no
    // lid). The successor reports only the LID form. Both resolve to the same
    // synthetic e164 via resolveComparableIdentity, so identitiesOverlap
    // accepts the fallback. (resolveComparableIdentity preserves an explicit
    // e164 on the input over deriving from the JID via authDir lookup.)
    const sharedE164 = "+123";
    const sockB = {
      sendMessage: vi.fn(async () => ({ key: { id: "post-restart-lid-msg-id" } })),
    };
    const handleB = {
      getActiveListener: () => null,
      getCurrentSock: () => sockB as never,
      getSelfIdentity: () => ({ jid: null, lid: "12300:1@lid", e164: sharedE164 }),
    } as never;
    controllerContexts.set(DEFAULT_ACCOUNT_ID, handleB);

    try {
      await inbound.reply("pong");
      expect(sockB.sendMessage).toHaveBeenCalledTimes(1);
      expect(sockB.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", { text: "pong" });
    } finally {
      controllerContexts.delete(DEFAULT_ACCOUNT_ID);
      await listenerA.close();
    }
  });

  // VE-513 session-safety guard: if the registered successor controller has been
  // re-linked to a different WhatsApp identity (different self JID), the
  // captured reply must fail closed rather than route through the wrong number.

  it("socket session refuses a successor with a mismatched self identity", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRefA = createSocketRef();

    let aShouldRetryDisconnect = true;
    const { listener: listenerA, sock: sockA } = await startInboxMonitor(
      onMessage as InboxOnMessage,
      {
        socketRef: socketRefA,
        shouldRetryDisconnect: () => aShouldRetryDisconnect,
        disconnectRetryPolicy: fastReconnectPolicy(1),
      },
    );

    sockA.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("outbound-successor-mismatch"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);
    const inbound = inboundMessage(onMessage);

    // A's shutdown sequence.
    socketRefA.current = null;
    aShouldRetryDisconnect = false;

    // === Successor is registered but with a DIFFERENT self identity (relink/repair) ===
    const sockB = {
      sendMessage: vi.fn(async () => ({ key: { id: "should-not-be-called" } })),
    };
    const handleBMismatch = {
      getActiveListener: () => null,
      getCurrentSock: () => sockB as never,
      getSelfIdentity: () => ({ jid: "456@s.whatsapp.net", lid: null }),
    } as never;
    controllerContexts.set(DEFAULT_ACCOUNT_ID, handleBMismatch);

    try {
      await expect(inbound.reply("pong")).rejects.toThrow(
        "no active socket - reconnection in progress",
      );

      // The mismatched successor's socket was never used.
      expect(sockB.sendMessage).not.toHaveBeenCalled();
    } finally {
      controllerContexts.delete(DEFAULT_ACCOUNT_ID);
      await listenerA.close();
    }
  });
});
