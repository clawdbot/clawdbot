import fsSync from "node:fs";
import path from "node:path";
import "./monitor-inbox.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppRetryableInboundError } from "./inbound/dedupe.js";
import { WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES } from "./inbound/monitor.js";
import {
  type InboxMonitorOptions,
  InboxOnMessage,
  buildNotifyMessageUpsert,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

const { sleepWithAbortMock } = vi.hoisted(() => ({
  sleepWithAbortMock: vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined),
}));

vi.mock("./reconnect.js", async () => {
  const actual = await vi.importActual<typeof import("./reconnect.js")>("./reconnect.js");
  return {
    ...actual,
    sleepWithAbort: (ms: number, signal?: AbortSignal) => sleepWithAbortMock(ms, signal),
  };
});

let nextMessageSequence = 0;

function nextMessageId(label: string): string {
  nextMessageSequence += 1;
  return `${label}-${nextMessageSequence}`;
}

function createSocketRef(): NonNullable<InboxMonitorOptions["socketRef"]> {
  return { current: null };
}

function inboundMessage(onMessage: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const msg = onMessage.mock.calls[index]?.[0];
  expect(msg).toBeDefined();
  return msg as Record<string, unknown>;
}

async function primeInboundReplyHandle(params: {
  onMessage: ReturnType<typeof vi.fn>;
  socketRef: NonNullable<InboxMonitorOptions["socketRef"]>;
  upsertId: string;
  retryPolicy: NonNullable<InboxMonitorOptions["disconnectRetryPolicy"]>;
  useCurrentSock?: boolean;
}) {
  const { listener, sock } = await startInboxMonitor(params.onMessage as InboxOnMessage, {
    socketRef: params.socketRef,
    shouldRetryDisconnect: () => true,
    disconnectRetryPolicy: params.retryPolicy,
  });
  const sourceSock = params.useCurrentSock ? getSock() : sock;
  sourceSock.ev.emit(
    "messages.upsert",
    buildNotifyMessageUpsert({
      id: nextMessageId(params.upsertId),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    }),
  );
  await waitForMessageCalls(params.onMessage, 1);

  const inbound = params.onMessage.mock.calls.at(0)?.at(0) as
    | {
        reply: (text: string) => Promise<void>;
      }
    | undefined;
  expect(inbound).toBeDefined();

  return { listener, sock, inbound };
}

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  beforeEach(() => {
    sleepWithAbortMock.mockReset();
    sleepWithAbortMock.mockImplementation(async (_ms: number, _signal?: AbortSignal) => undefined);
  });

  async function expectQuotedReplyContext(quotedMessage: unknown) {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("pong");
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: nextMessageId("quoted"),
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: {
            extendedTextMessage: {
              text: "reply",
              contextInfo: {
                stanzaId: "q1",
                participant: "111@s.whatsapp.net",
                quotedMessage,
              },
            },
          },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.replyToId).toBe("q1");
    expect(inbound.replyToBody).toBe("original");
    expect(inbound.replyToSender).toBe("+111");
    const sender = inbound.sender as { e164?: string; name?: string };
    expect(sender.e164).toBe("+999");
    expect(sender.name).toBe("Tester");
    const replyTo = inbound.replyTo as {
      body?: string;
      id?: string;
      sender?: { e164?: string; jid?: string; label?: string };
    };
    expect(replyTo.id).toBe("q1");
    expect(replyTo.body).toBe("original");
    expect(replyTo.sender?.jid).toBe("111@s.whatsapp.net");
    expect(replyTo.sender?.e164).toBe("+111");
    expect(replyTo.sender?.label).toBe("+111");
    const self = inbound.self as { e164?: string; jid?: string };
    expect(self.jid).toBe("123@s.whatsapp.net");
    expect(self.e164).toBe("+123");
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });

    await listener.close();
  }

  it("streams inbound messages", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.sendComposing();
      await msg.reply("pong");
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
    expect(inbound.body).toBe("ping");
    expect(inbound.from).toBe("+999");
    expect(inbound.to).toBe("+123");
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
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });

    await listener.close();
  });

  it("stays unavailable on connect in self-chat mode", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      selfChatMode: true,
    });

    expect(sock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "unavailable");

    await listener.close();
  });

  it("hydrates participating groups once after connect", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage);

    expect(sock.groupFetchAllParticipating).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("continues when group hydration fails on connect", async () => {
    const sock = getSock();
    sock.groupFetchAllParticipating.mockRejectedValueOnce(new Error("no groups"));

    const { listener } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage);

    expect(sock.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    expect(sock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "available");

    await listener.close();
  });

  it("keeps group inbound alive with cached metadata after reconnect-time metadata fetch failures", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const onMessage = vi.fn(async (_msg: Parameters<InboxOnMessage>[0]) => {
      return;
    });

    const firstSock = getSock();
    firstSock.groupFetchAllParticipating.mockResolvedValueOnce({
      "123@g.us": {
        id: "123@g.us",
        subject: "Recovered Group",
        owner: undefined,
        participants: [{ id: "444@s.whatsapp.net" }],
      },
    });
    const first = await startInboxMonitor(onMessage as InboxOnMessage, {
      groupMetadataCache,
    });
    await vi.waitFor(() => {
      expect(groupMetadataCache.get("123@g.us")?.subject).toBe("Recovered Group");
    });
    expect(
      (groupMetadataCache.get("123@g.us") as Record<string, unknown>)?.participants,
    ).toBeUndefined();
    await first.listener.close();

    const second = await startInboxMonitor(onMessage as InboxOnMessage, {
      groupMetadataCache,
    });
    second.sock.groupMetadata.mockRejectedValueOnce(new Error("408 timed out"));
    second.sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("group-reconnect-cache"),
        remoteJid: "123@g.us",
        participant: "444@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
      }),
    );

    await waitForMessageCalls(onMessage, 1);
    const inbound = inboundMessage(onMessage);
    expect(inbound.body).toBe("ping");
    expect(inbound.from).toBe("123@g.us");
    expect(inbound.groupSubject).toBe("Recovered Group");
    expect(inbound.senderE164).toBe("+444");
    expect(inbound.chatType).toBe("group");
    expect(onMessage.mock.calls.at(0)?.[0].groupParticipants).toBeUndefined();

    await second.listener.close();
  });

  it("bounds cached group metadata kept across reconnects", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const groups = Object.fromEntries(
      Array.from({ length: WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES + 2 }, (_, index) => [
        `${index}@g.us`,
        {
          id: `${index}@g.us`,
          subject: `Group ${index}`,
          owner: undefined,
          participants: [],
        },
      ]),
    );
    const sock = getSock();
    sock.groupFetchAllParticipating.mockResolvedValueOnce(groups);

    const { listener } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      groupMetadataCache,
    });

    await vi.waitFor(() => {
      expect(groupMetadataCache.size).toBe(WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES);
    });
    expect(groupMetadataCache.has("0@g.us")).toBe(false);
    expect(groupMetadataCache.has(`${WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES + 1}@g.us`)).toBe(
      true,
    );

    await listener.close();
  });

  it("does not block inbound listeners while group hydration is pending", async () => {
    let resolveHydration!: () => void;
    const sock = getSock();
    const pendingHydration = new Promise<Record<string, never>>((resolve) => {
      resolveHydration = () => resolve({});
    });
    sock.groupFetchAllParticipating.mockImplementationOnce(() => pendingHydration);
    const onMessage = vi.fn(async () => {
      return;
    });

    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("pending-hydration"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    resolveHydration();
    await listener.close();
  });

  it("uses a replacement socket for replies created before reconnect", async () => {
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

    const inbound = onMessage.mock.calls.at(0)?.at(0) as
      | {
          reply: (text: string) => Promise<void>;
          sendMedia: (payload: Record<string, unknown>) => Promise<void>;
          sendComposing: () => Promise<void>;
        }
      | undefined;
    expect(inbound).toBeDefined();

    const replacementSock = {
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    socketRef.current = replacementSock as unknown as NonNullable<
      InboxMonitorOptions["socketRef"]
    >["current"];

    await inbound?.reply("pong");
    await inbound?.sendMedia({ text: "after-reconnect" });
    await inbound?.sendComposing();

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

  it("waits for a replacement socket before sending replies", async () => {
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

    await inbound?.reply("pong");

    expect(sleepWithAbortMock).toHaveBeenCalledWith(10, undefined);
    expect(replacementSock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });
    expect(sock.sendMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("flushes pending debounced inbound batches after close", async () => {
    vi.useFakeTimers();
    try {
      const onMessage = vi.fn(async () => undefined);
      const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
        debounceMs: 50,
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
      sock.ev.emit(
        "messages.upsert",
        buildNotifyMessageUpsert({
          id: nextMessageId("debounce-close-2"),
          remoteJid: "999@s.whatsapp.net",
          text: "second",
          timestamp: 1_700_000_001,
          pushName: "Tester",
        }),
      );

      await listener.close();
      await vi.advanceTimersByTimeAsync(50);
      await waitForMessageCalls(onMessage, 1);
      expect(inboundMessage(onMessage).body).toBe("first\nsecond");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries timed-out sends on the same socket without clearing the socket ref", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const { listener, sock, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      upsertId: "timeout-retry",
      retryPolicy: {
        initialMs: 1,
        maxMs: 1,
        factor: 1,
        jitter: 0,
        maxAttempts: 2,
      },
    });

    sock.sendMessage
      .mockRejectedValueOnce(new Error("operation timed out"))
      .mockResolvedValueOnce({ key: { id: "after-timeout" } });

    await inbound?.reply("pong");

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

  it("bounds reconnect-gap retries even when reconnect attempts are unlimited", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef = createSocketRef();
    const { listener, inbound } = await primeInboundReplyHandle({
      onMessage,
      socketRef,
      upsertId: "unlimited-reconnect-send-bound",
      retryPolicy: {
        initialMs: 1,
        maxMs: 1,
        factor: 1,
        jitter: 0,
        maxAttempts: 0,
      },
      useCurrentSock: true,
    });

    socketRef.current = null;

    await expect(inbound?.reply("pong")).rejects.toThrow(
      "no active socket - reconnection in progress",
    );
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(11);

    await listener.close();
  });

  it("deduplicates redelivered messages by id", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });

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

  it("retries redelivered messages after an explicit retryable inbound failure", async () => {
    let attempts = 0;
    const onMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new WhatsAppRetryableInboundError("retry me");
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
    await waitForMessageCalls(onMessage, 1);

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);

    await listener.close();
  });

  it("resolves LID JIDs using Baileys LID mapping store", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce("999:0@s.whatsapp.net");
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("lid-store"),
      remoteJid: "999@lid",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    expect(getPNForLID).toHaveBeenCalledWith("999@lid");
    const inbound = inboundMessage(onMessage);
    expect(inbound.body).toBe("ping");
    expect(inbound.from).toBe("+999");
    expect(inbound.to).toBe("+123");

    await listener.close();
  });

  it("resolves LID JIDs via authDir mapping files", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });
    fsSync.writeFileSync(
      path.join(getAuthDir(), "lid-mapping-555_reverse.json"),
      JSON.stringify("1555"),
    );

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("lid-authdir"),
      remoteJid: "555@lid",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.body).toBe("ping");
    expect(inbound.from).toBe("+1555");
    expect(inbound.to).toBe("+123");
    expect(getPNForLID).not.toHaveBeenCalled();

    await listener.close();
  });

  it("resolves group participant LID JIDs via Baileys mapping", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce("444:0@s.whatsapp.net");
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("group-lid"),
      remoteJid: "123@g.us",
      participant: "444@lid",
      text: "ping",
      timestamp: 1_700_000_000,
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    expect(getPNForLID).toHaveBeenCalledWith("444@lid");
    const inbound = inboundMessage(onMessage);
    expect(inbound.body).toBe("ping");
    expect(inbound.from).toBe("123@g.us");
    expect(inbound.senderE164).toBe("+444");
    expect(inbound.chatType).toBe("group");

    await listener.close();
  });

  it("does not block follow-up messages when handler is pending", async () => {
    let resolveFirst: (() => void) | null = null;
    const onMessage = vi.fn(async () => {
      if (!resolveFirst) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
        },
        {
          key: { id: "abc2", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "pong" },
          messageTimestamp: 1_700_000_001,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);

    expect(onMessage).toHaveBeenCalledTimes(2);

    (resolveFirst as (() => void) | null)?.();
    await listener.close();
  });

  it("captures reply context from quoted messages", async () => {
    await expectQuotedReplyContext({ conversation: "original" });
  });

  it("captures reply context from wrapped quoted messages", async () => {
    await expectQuotedReplyContext({
      viewOnceMessageV2Extension: {
        message: { conversation: "original" },
      },
    });
  });

  it("captures reply context from botInvokeMessage wrapped quoted messages", async () => {
    await expectQuotedReplyContext({
      botInvokeMessage: {
        message: { conversation: "original" },
      },
    });
  });

  it("captures reply context from groupMentionedMessage wrapped quoted messages", async () => {
    await expectQuotedReplyContext({
      groupMentionedMessage: {
        message: { conversation: "original" },
      },
    });
  });
});
