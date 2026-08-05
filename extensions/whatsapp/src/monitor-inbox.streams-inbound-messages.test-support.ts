// WhatsApp monitor inbox delivery and lifecycle behavior.
import type { GroupMetadata, WAMessageKey } from "baileys";
import { beforeEach, expect, vi } from "vitest";
import {
  readWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
  type WhatsAppBaileysMessageCache,
} from "./inbound/baileys-cache.js";

export const EXPECTED_WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;
import type { WebInboundMessage } from "./inbound/types.js";
import {
  type InboxMonitorOptions,
  buildNotifyMessageUpsert,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";
import type { InboxOnMessage } from "./monitor-inbox.test-harness.js";
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

export function nextMessageId(label: string): string {
  nextMessageSequence += 1;
  return `${label}-${nextMessageSequence}`;
}

export function createSocketRef(): NonNullable<InboxMonitorOptions["socketRef"]> {
  return { current: null };
}

export function fastReconnectPolicy(
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

export function inboundMessage(onMessage: ReturnType<typeof vi.fn>, index = 0): WebInboundMessage {
  const msg = onMessage.mock.calls[index]?.[0];
  expect(msg).toBeDefined();
  return msg as WebInboundMessage;
}

export function expectDeprecatedAdmissionAliases(inbound: WebInboundMessage) {
  expect(inbound.from).toBe(inbound.admission?.conversation.id);
  expect(inbound.conversationId).toBe(inbound.admission?.conversation.id);
  expect(inbound.accountId).toBe(inbound.admission?.accountId);
  expect(inbound.chatType).toBe(inbound.admission?.conversation.kind);
  expect(inbound.accessControlPassed).toBe(inbound.admission?.ingress.decision === "allow");
}

export async function expectSocketOperationTimeout(
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

export function groupMetadata(params: {
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

export function createBaileysCacheSupport() {
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

export async function startInboxMonitorWithBaileysCache(
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

export async function expectCachedGroupMetadata(
  baileysCache: ReturnType<typeof createBaileysCacheSupport>,
  expected: Pick<GroupMetadata, "id" | "subject" | "participants">,
) {
  await expect(baileysCache.socketOptions.cachedGroupMetadata(expected.id)).resolves.toMatchObject(
    expected,
  );
}

export async function primeInboundReplyHandle(params: {
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

export { controllerContexts, imageOps, sleepWithAbortMock };

export function installStreamsInboundMessageHooks() {
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
}
