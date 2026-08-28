// WhatsApp monitor inbox behavior split by ownership.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
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

function createAcceptedSendMessageMock() {
  let sequence = 0;
  return vi.fn().mockImplementation(async () => ({
    key: { id: `replacement-accepted-${++sequence}` },
  }));
}

type SuccessorIdentity = {
  jid: string | null;
  lid: string | null;
  e164?: string;
};

async function primeCapturedReplyWithSuccessor(params: {
  upsertId: string;
  acceptedMessageId: string;
  identity: SuccessorIdentity;
}) {
  const onMessage = vi.fn(async () => undefined);
  const socketRef = createSocketRef();
  let shouldRetryDisconnect = true;
  const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
    socketRef,
    shouldRetryDisconnect: () => shouldRetryDisconnect,
    disconnectRetryPolicy: fastReconnectPolicy(1),
  });

  sock.ev.emit(
    "messages.upsert",
    buildNotifyMessageUpsert({
      id: nextMessageId(params.upsertId),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    }),
  );
  await waitForMessageCalls(onMessage, 1);
  const inbound = inboundMessage(onMessage);

  // Model the health monitor replacing controller A while its captured reply remains live.
  socketRef.current = null;
  shouldRetryDisconnect = false;
  const successorSock = {
    sendMessage: vi.fn(async () => ({ key: { id: params.acceptedMessageId } })),
  };
  controllerContexts.set(DEFAULT_ACCOUNT_ID, {
    getActiveListener: () => null,
    getCurrentSock: () => successorSock as never,
    getSelfIdentity: () => params.identity,
  } as never);

  return {
    inbound,
    successorSock,
    close: async () => {
      controllerContexts.delete(DEFAULT_ACCOUNT_ID);
      await listener.close();
    },
  };
}

describe("web monitor inbox socket lifecycle", () => {
  installStreamsInboundMessageHooks();

  it("socket session marks only preflight reachout timelocks as retryable no-send", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage);
    sock.fetchAccountReachoutTimelock.mockResolvedValue({
      isActive: true,
      enforcementType: "RESTRICT_ALL_COMPANIONS",
      timeEnforcementEnds: new Date(Date.now() + 60_000),
    });
    try {
      await expect(listener.assertSendReady!("+1555")).rejects.toMatchObject({
        name: "PlatformMessageNotDispatchedError",
        retryable: true,
        cause: expect.objectContaining({
          message: expect.stringContaining("WhatsApp reachout timelock is active"),
        }),
      });
      await expect(listener.sendMessage("+1555", "hello")).rejects.not.toBeInstanceOf(
        PlatformMessageNotDispatchedError,
      );
      expect(sock.sendMessage).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

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
      sendMessage: createAcceptedSendMessageMock(),
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
      sendMessage: createAcceptedSendMessageMock(),
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

  it("socket session routes captured replies through a matching successor", async () => {
    const { inbound, successorSock, close } = await primeCapturedReplyWithSuccessor({
      upsertId: "outbound-successor",
      acceptedMessageId: "post-restart-msg-id",
      identity: { jid: "123@s.whatsapp.net", lid: null },
    });

    try {
      await inbound.platform.reply("pong");
      await inbound.platform.sendMedia({ text: "media after restart" });

      expect(successorSock.sendMessage).toHaveBeenCalledTimes(2);
      expect(successorSock.sendMessage).toHaveBeenNthCalledWith(1, "999@s.whatsapp.net", {
        text: "pong",
      });
      expect(successorSock.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
        text: "media after restart",
      });
    } finally {
      await close();
    }
  });

  // Reconnects may rotate the self identity from a phone JID to a LID; the
  // matching e164 must keep the captured reply usable across that rotation.
  it("socket session accepts a successor with equivalent LID and phone identity", async () => {
    const { inbound, successorSock, close } = await primeCapturedReplyWithSuccessor({
      upsertId: "outbound-successor-lid",
      acceptedMessageId: "post-restart-lid-msg-id",
      identity: { jid: null, lid: "12300:1@lid", e164: "+123" },
    });

    try {
      await inbound.platform.reply("pong");
      expect(successorSock.sendMessage).toHaveBeenCalledTimes(1);
      expect(successorSock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
        text: "pong",
      });
    } finally {
      await close();
    }
  });

  // A re-linked successor can belong to another account, so mismatched self
  // identity must fail closed instead of sending the captured reply there.
  it("socket session refuses a successor with a mismatched self identity", async () => {
    const { inbound, successorSock, close } = await primeCapturedReplyWithSuccessor({
      upsertId: "outbound-successor-mismatch",
      acceptedMessageId: "should-not-be-called",
      identity: { jid: "456@s.whatsapp.net", lid: null },
    });

    try {
      await expect(inbound.platform.reply("pong")).rejects.toThrow(
        "no active socket - reconnection in progress",
      );
      expect(successorSock.sendMessage).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
