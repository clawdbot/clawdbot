// Whatsapp plugin module implements monitor inbox.streams inbound messages support behavior.
import fsSync from "node:fs";
import path from "node:path";
import type { GroupMetadata, WAMessageKey } from "baileys";
import "./monitor-inbox.test-harness.js";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
  type WhatsAppBaileysMessageCache,
} from "./inbound/monitor.js";

const EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;
import { createWhatsAppDurableInboundQueue } from "./inbound/durable-receive.js";
import { resolveWhatsAppIngressLifecycle } from "./inbound/ingress-lifecycle.js";
import type { WebInboundMessage } from "./inbound/types.js";
import {
  type InboxMonitorOptions,
  buildNotifyMessageUpsert,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_WEB_INBOX_CONFIG,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  resetWebInboundDedupeForTests,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";
import type { InboxOnMessage } from "./monitor-inbox.test-harness.js";
import { lookupInboundMessageMeta } from "./quoted-message.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

const { controllerContexts, imageOps, sleepWithAbortMock } = vi.hoisted(() => ({
  controllerContexts: new Map<string, unknown>(),
  imageOps: {
    getImageMetadata: vi.fn(),
    resizeToJpeg: vi.fn(),
  },
  sleepWithAbortMock: vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined),
}));

vi.mock("./connection-controller-runtime-context.js", () => ({
  WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY: "connection-controller",
  getWhatsAppConnectionController: (accountId: string) => controllerContexts.get(accountId) ?? null,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    getImageMetadata: imageOps.getImageMetadata,
    resizeToJpeg: imageOps.resizeToJpeg,
  };
});

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

function fastReconnectPolicy(
  maxAttempts: number,
): NonNullable<InboxMonitorOptions["disconnectRetryPolicy"]> {
  return {
    initialMs: 1,
    maxMs: 1,
    factor: 1,
    jitter: 0,
    maxAttempts,
  };
}

function inboundMessage(onMessage: ReturnType<typeof vi.fn>, index = 0): WebInboundMessage {
  const msg = onMessage.mock.calls[index]?.[0];
  expect(msg).toBeDefined();
  return msg as WebInboundMessage;
}

function expectDeprecatedAdmissionAliases(inbound: WebInboundMessage) {
  expect(inbound.from).toBe(inbound.admission?.conversation.id);
  expect(inbound.conversationId).toBe(inbound.admission?.conversation.id);
  expect(inbound.accountId).toBe(inbound.admission?.accountId);
  expect(inbound.chatType).toBe(inbound.admission?.conversation.kind);
  expect(inbound.accessControlPassed).toBe(inbound.admission?.ingress.decision === "allow");
}

async function expectSocketOperationTimeout(
  operation: "sendMessage" | "sendPresenceUpdate",
  promise: Promise<unknown>,
) {
  const rejection = expect(promise).rejects.toMatchObject({
    name: "WhatsAppSocketOperationTimeoutError",
    operation,
    timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    deliveryState: "unknown",
  });
  await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
  await rejection;
}

function groupMetadata(params: {
  id?: string;
  subject: string;
  participants?: string[];
}): GroupMetadata {
  return {
    id: params.id ?? "123@g.us",
    subject: params.subject,
    owner: undefined,
    participants: (params.participants ?? ["555@s.whatsapp.net"]).map((id) => ({ id })),
  };
}

function createBaileysCacheSupport() {
  const recentMessageKeys: WhatsAppBaileysMessageCache = new Map();
  const baileysGroupMetaCache: WhatsAppBaileysGroupMetadataCache = new Map();
  const socketOptions = {
    getMessage: async (key: WAMessageKey) =>
      key.id && key.remoteJid
        ? readWhatsAppBaileysCacheEntry(recentMessageKeys, `${key.remoteJid}:${key.id}`)
        : undefined,
    cachedGroupMetadata: async (jid: string) => {
      const meta = readWhatsAppBaileysCacheEntry(baileysGroupMetaCache, jid);
      return meta?.participants?.length ? meta : undefined;
    },
  };
  return { recentMessageKeys, baileysGroupMetaCache, socketOptions };
}

async function startInboxMonitorWithBaileysCache(
  options: Partial<Pick<InboxMonitorOptions, "groupMetadataCache">> = {},
) {
  const baileysCache = createBaileysCacheSupport();
  const started = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
    ...options,
    recentMessageKeys: baileysCache.recentMessageKeys,
    baileysGroupMetaCache: baileysCache.baileysGroupMetaCache,
  });
  return { ...started, baileysCache };
}

async function expectCachedGroupMetadata(
  baileysCache: ReturnType<typeof createBaileysCacheSupport>,
  expected: Pick<GroupMetadata, "id" | "subject" | "participants">,
) {
  await expect(baileysCache.socketOptions.cachedGroupMetadata(expected.id)).resolves.toMatchObject(
    expected,
  );
}

async function primeInboundReplyHandle(params: {
  onMessage: ReturnType<typeof vi.fn>;
  socketRef: NonNullable<InboxMonitorOptions["socketRef"]>;
  upsertId: string;
  retryPolicy: NonNullable<InboxMonitorOptions["disconnectRetryPolicy"]>;
  baileysCache?: ReturnType<typeof createBaileysCacheSupport>;
  useCurrentSock?: boolean;
}) {
  const { listener, sock } = await startInboxMonitor(params.onMessage as InboxOnMessage, {
    socketRef: params.socketRef,
    shouldRetryDisconnect: () => true,
    disconnectRetryPolicy: params.retryPolicy,
    recentMessageKeys: params.baileysCache?.recentMessageKeys,
    baileysGroupMetaCache: params.baileysCache?.baileysGroupMetaCache,
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

  const inbound = inboundMessage(params.onMessage);

  return { listener, sock, inbound };
}

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  beforeEach(() => {
    controllerContexts.clear();
    imageOps.getImageMetadata.mockReset();
    imageOps.getImageMetadata.mockResolvedValue(null);
    imageOps.resizeToJpeg.mockReset();
    imageOps.resizeToJpeg.mockRejectedValue(new Error("unexpected thumbnail generation"));
    sleepWithAbortMock.mockReset();
    sleepWithAbortMock.mockImplementation(async (_ms: number, _signal?: AbortSignal) => undefined);
  });

  async function expectQuotedReplyContext(quotedMessage: unknown) {
    const onMessage = vi.fn(async (msg) => {
      await msg.platform.reply("pong");
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
    expect(inbound.quote?.id).toBe("q1");
    expect(inbound.quote?.body).toBe("original");
    expect(inbound.quote?.sender?.displayName).toBe("+111");
    const sender = inbound.platform.sender as { e164?: string; name?: string };
    expect(sender.e164).toBe("+999");
    expect(sender.name).toBe("Tester");
    const replyTo = inbound.quote?.context as {
      body?: string;
      id?: string;
      sender?: { e164?: string; jid?: string; label?: string };
    };
    expect(replyTo.id).toBe("q1");
    expect(replyTo.body).toBe("original");
    expect(replyTo.sender?.jid).toBe("111@s.whatsapp.net");
    expect(replyTo.sender?.e164).toBe("+111");
    expect(replyTo.sender?.label).toBe("+111");
    const self = inbound.platform.self as { e164?: string; jid?: string };
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
      await msg.reply("flat reply works");
      await msg.sendMedia({ text: "flat media works" });
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
    expectDeprecatedAdmissionAliases(inbound);
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
      text: "flat reply works",
    });
    expect(sock.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
      text: "flat media works",
    });

    await listener.close();
  });

  it("delays read receipts until inbound handlers complete", async () => {
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

  it("keeps the first delivery's prepared entry when a duplicate arrives", async () => {
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
    // Duplicate delivery of the same message id: its pending verdict must not
    // delete the first delivery's kept preparation.
    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    await settleInboundWork();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(inboundMessage(onMessage).payload.body).toBe("first");
    await listener.close();
  });

  it("retries a transient persistence failure and still delivers through the drain", async () => {
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

  it("does not dispatch live duplicates that already have pending durable delivery", async () => {
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

  it("does not redispatch a completed transport-key duplicate", async () => {
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

  it("omits group context when a group message has no group facts", async () => {
    const sock = getSock();
    sock.groupFetchAllParticipating.mockRejectedValueOnce(new Error("no groups"));
    const onMessage = vi.fn(async () => {});
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.groupMetadata.mockRejectedValueOnce(new Error("group metadata unavailable"));

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("group-no-facts"),
        remoteJid: "123@g.us",
        participant: "444@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
      }),
    );

    await waitForMessageCalls(onMessage, 1);
    const inbound = inboundMessage(onMessage);
    expect(inbound.admission?.conversation.kind).toBe("group");
    expect(inbound.group).toBeUndefined();

    await listener.close();
  });

  it("keeps group inbound alive with cached metadata after reconnect-time metadata fetch failures", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const onMessage = vi.fn(async (_msg: Parameters<InboxOnMessage>[0]) => {});

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
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("123@g.us");
    expect(inbound.group?.subject).toBe("Recovered Group");
    expect(inbound.platform.senderE164).toBe("+444");
    expect(inbound.admission?.conversation.kind).toBe("group");
    expect(inbound.group?.participants).toBeUndefined();

    await second.listener.close();
  });

  it("keeps full participating group metadata available to Baileys", async () => {
    const sock = getSock();
    sock.groupFetchAllParticipating.mockResolvedValueOnce({
      "123@g.us": groupMetadata({
        subject: "Recovered Group",
        participants: ["444@s.whatsapp.net"],
      }),
    });

    const { listener, baileysCache } = await startInboxMonitorWithBaileysCache();

    await vi.waitFor(async () => {
      await expectCachedGroupMetadata(baileysCache, {
        id: "123@g.us",
        subject: "Recovered Group",
        participants: [{ id: "444@s.whatsapp.net" }],
      });
    });

    await listener.close();
  });

  it("invalidates cached group metadata on partial group and participant updates", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const { listener, sock, baileysCache } = await startInboxMonitorWithBaileysCache({
      groupMetadataCache,
    });
    sock.ev.emit("groups.update", [
      groupMetadata({
        subject: "Fresh Group",
      }),
    ]);
    await expectCachedGroupMetadata(baileysCache, {
      id: "123@g.us",
      subject: "Fresh Group",
      participants: [{ id: "555@s.whatsapp.net" }],
    });
    expect(groupMetadataCache.has("123@g.us")).toBe(true);

    sock.ev.emit("groups.update", [{ id: "123@g.us" }]);
    expect(groupMetadataCache.has("123@g.us")).toBe(false);
    await expect(
      baileysCache.socketOptions.cachedGroupMetadata("123@g.us"),
    ).resolves.toBeUndefined();
    sock.ev.emit("groups.update", [
      groupMetadata({
        subject: "Fresh Again",
      }),
    ]);
    expect(groupMetadataCache.has("123@g.us")).toBe(true);
    sock.ev.emit("group-participants.update", { id: "123@g.us" });
    expect(groupMetadataCache.has("123@g.us")).toBe(false);
    await expect(
      baileysCache.socketOptions.cachedGroupMetadata("123@g.us"),
    ).resolves.toBeUndefined();

    await listener.close();
  });

  it("expires Baileys retry and group metadata cache entries", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const baileysCache = createBaileysCacheSupport();
    const onMessage = vi.fn(async (_msg: Parameters<InboxOnMessage>[0]) => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      recentMessageKeys: baileysCache.recentMessageKeys,
      baileysGroupMetaCache: baileysCache.baileysGroupMetaCache,
    });
    const messageId = nextMessageId("baileys-expiry");
    try {
      sock.ev.emit(
        "messages.upsert",
        buildNotifyMessageUpsert({
          id: messageId,
          remoteJid: "999@s.whatsapp.net",
          text: "retry me",
          timestamp: 1_700_000_000,
          pushName: "Tester",
        }),
      );
      sock.ev.emit("groups.update", [
        groupMetadata({
          subject: "Expiring Group",
        }),
      ]);
      await waitForMessageCalls(onMessage, 1);

      await expect(
        baileysCache.socketOptions.getMessage({
          id: messageId,
          remoteJid: "999@s.whatsapp.net",
        }),
      ).resolves.toEqual({ conversation: "retry me" });
      await expectCachedGroupMetadata(baileysCache, {
        id: "123@g.us",
        subject: "Expiring Group",
        participants: [{ id: "555@s.whatsapp.net" }],
      });

      now.mockReturnValue(1_700_000_000_000 + 5 * 60 * 1000 + 1);
      await expect(
        baileysCache.socketOptions.cachedGroupMetadata("123@g.us"),
      ).resolves.toBeUndefined();

      now.mockReturnValue(1_700_000_000_000 + 10 * 60 * 1000 + 1);
      await expect(
        baileysCache.socketOptions.getMessage({
          id: messageId,
          remoteJid: "999@s.whatsapp.net",
        }),
      ).resolves.toBeUndefined();
    } finally {
      now.mockRestore();
      await listener.close();
    }
  });

  it("does not republish invalidated group metadata from pending hydration", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const baileysCache = createBaileysCacheSupport();
    const sock = getSock();
    let resolveHydration!: (groups: Record<string, GroupMetadata>) => void;
    sock.groupFetchAllParticipating.mockImplementationOnce(
      async () =>
        await new Promise<Record<string, GroupMetadata>>((resolve) => {
          resolveHydration = resolve;
        }),
    );

    const { listener } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      groupMetadataCache,
      recentMessageKeys: baileysCache.recentMessageKeys,
      baileysGroupMetaCache: baileysCache.baileysGroupMetaCache,
    });
    sock.ev.emit("groups.update", [{ id: "123@g.us" }]);

    resolveHydration({
      "123@g.us": groupMetadata({
        subject: "Stale Hydration Group",
      }),
    });
    await settleInboundWork();

    expect(groupMetadataCache.has("123@g.us")).toBe(false);
    await expect(
      baileysCache.socketOptions.cachedGroupMetadata("123@g.us"),
    ).resolves.toBeUndefined();

    await listener.close();
  });

  it("cleans up Baileys group metadata listeners on close", async () => {
    const baileysCache = createBaileysCacheSupport();
    const { listener, sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      recentMessageKeys: baileysCache.recentMessageKeys,
      baileysGroupMetaCache: baileysCache.baileysGroupMetaCache,
    });

    expect(sock.ev.listenerCount("groups.upsert")).toBe(1);
    expect(sock.ev.listenerCount("groups.update")).toBe(1);
    expect(sock.ev.listenerCount("group-participants.update")).toBe(1);

    await listener.close();

    expect(sock.ev.listenerCount("groups.upsert")).toBe(0);
    expect(sock.ev.listenerCount("groups.update")).toBe(0);
    expect(sock.ev.listenerCount("group-participants.update")).toBe(0);
  });

  it("bounds cached group metadata kept across reconnects", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const groups = Object.fromEntries(
      Array.from({ length: EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES + 2 }, (_, index) => [
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
      expect(groupMetadataCache.size).toBe(EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES);
    });
    expect(groupMetadataCache.has("0@g.us")).toBe(false);
    expect(
      groupMetadataCache.has(`${EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES + 1}@g.us`),
    ).toBe(true);

    await listener.close();
  });

  it("does not keep reconnect group metadata when the expiry would exceed a valid Date", async () => {
    const groupMetadataCache: NonNullable<InboxMonitorOptions["groupMetadataCache"]> = new Map();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    try {
      const sock = getSock();
      sock.groupFetchAllParticipating.mockResolvedValueOnce({
        "123@g.us": {
          id: "123@g.us",
          subject: "Boundary Group",
          owner: undefined,
          participants: [],
        },
      });

      const { listener } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
        groupMetadataCache,
      });

      await vi.waitFor(() => {
        expect(sock.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
      });
      expect(groupMetadataCache.has("123@g.us")).toBe(false);

      await listener.close();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not block inbound listeners while group hydration is pending", async () => {
    let resolveHydration!: () => void;
    const sock = getSock();
    const pendingHydration = new Promise<Record<string, never>>((resolve) => {
      resolveHydration = () => resolve({});
    });
    sock.groupFetchAllParticipating.mockImplementationOnce(() => pendingHydration);
    const onMessage = vi.fn(async () => {});

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

  it("prepopulates image previews for inbound sendMedia replies", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("image-preview"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    const image = Buffer.from("img");
    const thumbnail = Buffer.from("thumb");
    imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
    imageOps.resizeToJpeg.mockResolvedValueOnce(thumbnail);

    await inbound.platform.sendMedia({ image, caption: "cap", mimetype: "image/png" });

    expect(imageOps.resizeToJpeg).toHaveBeenCalledWith({
      buffer: image,
      maxSide: 32,
      quality: 50,
      withoutEnlargement: true,
    });
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      image,
      caption: "cap",
      mimetype: "image/png",
      width: 640,
      height: 480,
      jpegThumbnail: thumbnail.toString("base64"),
    });

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

    await inbound?.platform.reply("pong");

    expect(sleepWithAbortMock).toHaveBeenCalledWith(10, undefined);
    expect(replacementSock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });
    expect(sock.sendMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("drains serialized same-lane messages after close", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (() => void) | undefined;
      const firstTurn = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const onMessage = vi.fn(async () => {
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
          id: nextMessageId("debounce-close-1"),
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
          id: nextMessageId("debounce-close-2"),
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
      expect(inboundMessage(onMessage, 1).admission?.conversation.kind).toBe("direct");
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes shutdown under a long durable debounce without waiting for the window", async () => {
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

  it("lets serialized same-lane replies drain before closing the socket", async () => {
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

  it("waits for in-flight inbound handlers before draining on close", async () => {
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

  it("retries timed-out sends on the same socket without clearing the socket ref", async () => {
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

  it("lets configured slow socket sends complete beyond thirty seconds", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      cfg: {
        ...DEFAULT_WEB_INBOX_CONFIG,
        web: { whatsapp: { defaultQueryTimeoutMs: 45_000 } },
      },
    });
    vi.useFakeTimers();
    try {
      sock.sendMessage.mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            setTimeout(() => resolve({ key: { id: "slow-success" } }), 40_000);
          }),
      );

      let settled = false;
      const sendPromise = listener.sendMessage("+1555", "hello").finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(sendPromise).resolves.toMatchObject({ messageId: "slow-success" });
      expect(vi.getTimerCount()).toBe(0);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await listener.close();
    }
  });

  it("rejects direct sends before Baileys sendMessage when reachout timelock is active", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.fetchAccountReachoutTimelock.mockResolvedValueOnce({
      isActive: true,
      enforcementType: "WEB_COMPANION_ONLY",
      timeEnforcementEnds: new Date(Date.now() + 60_000),
    });

    try {
      await expect(listener.sendMessage("+1555", "hello")).rejects.toThrow(
        "WhatsApp reachout timelock is active",
      );

      expect(sock.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

  it("uses connection.update reachout timelock state before direct sends", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit("connection.update", {
      reachoutTimeLock: {
        isActive: true,
        enforcementType: "WEB_COMPANION_ONLY",
      },
    });

    try {
      await expect(listener.sendMessage("+1555", "hello")).rejects.toThrow(
        "WhatsApp reachout timelock is active",
      );

      expect(sock.fetchAccountReachoutTimelock).not.toHaveBeenCalled();
      expect(sock.sendMessage).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

  it("allows direct sends after reachout timelock clears", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit("connection.update", {
      reachoutTimeLock: {
        isActive: true,
        enforcementType: "WEB_COMPANION_ONLY",
      },
    });
    sock.ev.emit("connection.update", {
      reachoutTimeLock: {
        isActive: false,
      },
    });

    try {
      await expect(listener.sendMessage("+1555", "hello")).resolves.toBeDefined();

      expect(sock.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      await listener.close();
    }
  });

  it("refreshes inactive reachout timelock state before later direct sends", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.fetchAccountReachoutTimelock
      .mockResolvedValueOnce({ isActive: false })
      .mockResolvedValueOnce({
        isActive: true,
        enforcementType: "WEB_COMPANION_ONLY",
        timeEnforcementEnds: new Date(Date.now() + 60_000),
      });

    try {
      await expect(listener.sendMessage("+1555", "first")).resolves.toBeDefined();
      await expect(listener.sendMessage("+1555", "second")).rejects.toThrow(
        "WhatsApp reachout timelock is active",
      );

      expect(sock.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(2);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      await listener.close();
    }
  });

  it("reuses a successful readiness preflight for the immediate direct send", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.fetchAccountReachoutTimelock.mockResolvedValueOnce({ isActive: false });

    try {
      await listener.assertSendReady?.("+1555");
      await expect(listener.sendMessage("+1555", "hello")).resolves.toBeDefined();

      expect(sock.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      await listener.close();
    }
  });

  it("invalidates readiness preflight when a later active timelock update arrives", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.fetchAccountReachoutTimelock.mockResolvedValueOnce({ isActive: false });

    try {
      await listener.assertSendReady?.("+1555");
      sock.ev.emit("connection.update", {
        reachoutTimeLock: {
          isActive: true,
          enforcementType: "WEB_COMPANION_ONLY",
        },
      });

      await expect(listener.sendMessage("+1555", "hello")).rejects.toThrow(
        "WhatsApp reachout timelock is active",
      );
      expect(sock.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

  it("does not apply account reachout timelock to group sends", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit("connection.update", {
      reachoutTimeLock: {
        isActive: true,
        enforcementType: "WEB_COMPANION_ONLY",
      },
    });

    try {
      await expect(listener.sendMessage("120363401234567890@g.us", "hello")).resolves.toBeDefined();

      expect(sock.fetchAccountReachoutTimelock).not.toHaveBeenCalled();
      expect(sock.sendMessage).toHaveBeenCalledWith("120363401234567890@g.us", { text: "hello" });
    } finally {
      await listener.close();
    }
  });

  it("blocks direct inbound composing presence when reachout timelock is active", async () => {
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

  it("times out stalled socket sends at the default Baileys query timeout", async () => {
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

  it("does not retry or clear the socket after the local socket send timeout", async () => {
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

  it("records outbound replies for Baileys retry lookup", async () => {
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

  it("suppresses self-echo when a timed-out socket send is later accepted", async () => {
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

  it("times out stalled send-api presence updates", async () => {
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

  it("bounds stalled read-receipt socket operations instead of hanging", async () => {
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

  it("bounds reconnect-gap retries even when reconnect attempts are unlimited", async () => {
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
  it("routes the captured reply through a successor controller when the original controller's socket is gone", async () => {
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
  it("accepts successor-controller fallback when only the LID-vs-PN form differs for the same account e164", async () => {
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
  it("refuses successor-controller fallback when the registered controller's self JID does not match", async () => {
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

  it("deduplicates redelivered messages by id", async () => {
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

  it("retries redelivered messages after an explicit retryable inbound failure", async () => {
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
    await waitForMessageCalls(onMessage, 1);
    expect(sock.readMessages).not.toHaveBeenCalled();

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledTimes(1);
    });

    await listener.close();
  });

  it("retries redelivered messages after reply session initialization conflicts", async () => {
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
    await waitForMessageCalls(onMessage, 1);
    expect(sock.readMessages).not.toHaveBeenCalled();

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledTimes(1);
    });

    await listener.close();
  });

  it("resolves LID JIDs using Baileys LID mapping store", async () => {
    const onMessage = vi.fn(async () => {});

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
    expect(getPNForLID).toHaveBeenCalledTimes(1);
    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("+999");
    expect(inbound.platform.recipientJid).toBe("+123");

    await listener.close();
  });

  it("resolves LID JIDs via authDir mapping files", async () => {
    const onMessage = vi.fn(async () => {});
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
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("+1555");
    expect(inbound.platform.recipientJid).toBe("+123");
    expect(getPNForLID).not.toHaveBeenCalled();

    await listener.close();
  });

  it("resolves group participant LID JIDs via Baileys mapping", async () => {
    const onMessage = vi.fn(async () => {});

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
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("123@g.us");
    expect(inbound.platform.senderE164).toBe("+444");
    expect(inbound.admission?.conversation.kind).toBe("group");

    await listener.close();
  });

  it("keeps a same-lane follow-up pending until the first handler adopts", async () => {
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
