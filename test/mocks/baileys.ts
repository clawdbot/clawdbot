import { EventEmitter } from "node:events";
import { vi } from "vitest";

type BaileysExports = typeof import("@whiskeysockets/baileys");
type FetchLatestBaileysVersionFn = BaileysExports["fetchLatestBaileysVersion"];
type MakeCacheableSignalKeyStoreFn = BaileysExports["makeCacheableSignalKeyStore"];
type MakeWASocketFn = BaileysExports["makeWASocket"];
type UseMultiFileAuthStateFn = BaileysExports["useMultiFileAuthState"];
type DownloadMediaMessageFn = BaileysExports["downloadMediaMessage"];
type ExtractMessageContentFn = BaileysExports["extractMessageContent"];
type GetContentTypeFn = BaileysExports["getContentType"];
type NormalizeMessageContentFn = BaileysExports["normalizeMessageContent"];
type IsJidGroupFn = BaileysExports["isJidGroup"];
type MessageContentInput = Parameters<NormalizeMessageContentFn>[0];
type MessageContentOutput = ReturnType<NormalizeMessageContentFn>;
type MessageContentType = ReturnType<GetContentTypeFn>;

export type MockBaileysSocket = {
  ev: EventEmitter;
  ws: { close: ReturnType<typeof vi.fn> };
  sendPresenceUpdate: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  readMessages: ReturnType<typeof vi.fn>;
  groupFetchAllParticipating: ReturnType<typeof vi.fn>;
  user?: { id?: string };
};

export type MockBaileysModule = {
  BufferJSON: {
    replacer: (key: string, value: unknown) => unknown;
    reviver: (key: string, value: unknown) => unknown;
  };
  DisconnectReason: { loggedOut: number };
  extractMessageContent: ReturnType<typeof vi.fn<ExtractMessageContentFn>>;
  fetchLatestBaileysVersion: ReturnType<typeof vi.fn<FetchLatestBaileysVersionFn>>;
  getContentType: ReturnType<typeof vi.fn<GetContentTypeFn>>;
  isJidGroup: ReturnType<typeof vi.fn<IsJidGroupFn>>;
  makeCacheableSignalKeyStore: ReturnType<typeof vi.fn<MakeCacheableSignalKeyStoreFn>>;
  makeWASocket: ReturnType<typeof vi.fn<MakeWASocketFn>>;
  normalizeMessageContent: ReturnType<typeof vi.fn<NormalizeMessageContentFn>>;
  useMultiFileAuthState: ReturnType<typeof vi.fn<UseMultiFileAuthStateFn>>;
  jidToE164?: (jid: string) => string | null;
  proto?: unknown;
  downloadMediaMessage?: ReturnType<typeof vi.fn<DownloadMediaMessageFn>>;
};

const MESSAGE_WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
] as const;

const MESSAGE_CONTENT_KEYS = [
  "conversation",
  "extendedTextMessage",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "locationMessage",
  "liveLocationMessage",
  "contactMessage",
  "contactsArrayMessage",
  "buttonsResponseMessage",
  "listResponseMessage",
  "templateButtonReplyMessage",
  "interactiveResponseMessage",
  "buttonsMessage",
  "listMessage",
] as const;

type MessageLike = Record<string, unknown>;

export function mockNormalizeMessageContent(message: MessageContentInput): MessageContentOutput {
  let current = message as unknown;
  while (current && typeof current === "object") {
    let unwrapped = false;
    for (const key of MESSAGE_WRAPPER_KEYS) {
      const candidate = (current as MessageLike)[key];
      if (
        candidate &&
        typeof candidate === "object" &&
        "message" in (candidate as MessageLike) &&
        (candidate as { message?: unknown }).message
      ) {
        current = (candidate as { message: unknown }).message;
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) {
      break;
    }
  }
  return current as MessageContentOutput;
}

export function mockGetContentType(message: MessageContentInput): MessageContentType {
  const normalized = mockNormalizeMessageContent(message);
  if (!normalized || typeof normalized !== "object") {
    return undefined;
  }
  for (const key of MESSAGE_CONTENT_KEYS) {
    if ((normalized as MessageLike)[key] != null) {
      return key as MessageContentType;
    }
  }
  return undefined;
}

export function mockExtractMessageContent(message: MessageContentInput): MessageContentOutput {
  const normalized = mockNormalizeMessageContent(message);
  if (!normalized || typeof normalized !== "object") {
    return normalized;
  }
  const contentType = mockGetContentType(normalized);
  if (!contentType || contentType === "conversation") {
    return normalized;
  }
  const candidate = (normalized as MessageLike)[contentType];
  return (
    candidate && typeof candidate === "object" ? candidate : normalized
  ) as MessageContentOutput;
}

export function mockIsJidGroup(jid: string | undefined | null): boolean {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

export function createMockBaileys(): {
  mod: MockBaileysModule;
  lastSocket: () => MockBaileysSocket;
} {
  const sockets: MockBaileysSocket[] = [];
  const makeWASocket = vi.fn<MakeWASocketFn>((_opts) => {
    const ev = new EventEmitter();
    const sock: MockBaileysSocket = {
      ev,
      ws: { close: vi.fn() },
      sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg123" } }),
      readMessages: vi.fn().mockResolvedValue(undefined),
      groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      user: { id: "123@s.whatsapp.net" },
    };
    setImmediate(() => ev.emit("connection.update", { connection: "open" }));
    sockets.push(sock);
    return sock as unknown as ReturnType<MakeWASocketFn>;
  });

  const mod: MockBaileysModule = {
    BufferJSON: {
      replacer: (_key: string, value: unknown) => value,
      reviver: (_key: string, value: unknown) => value,
    },
    DisconnectReason: { loggedOut: 401 },
    extractMessageContent: vi.fn<ExtractMessageContentFn>((message) =>
      mockExtractMessageContent(message),
    ),
    fetchLatestBaileysVersion: vi
      .fn<FetchLatestBaileysVersionFn>()
      .mockResolvedValue({ version: [1, 2, 3], isLatest: true }),
    getContentType: vi.fn<GetContentTypeFn>((message) => mockGetContentType(message)),
    isJidGroup: vi.fn<IsJidGroupFn>((jid) => mockIsJidGroup(jid)),
    makeCacheableSignalKeyStore: vi.fn<MakeCacheableSignalKeyStoreFn>((keys) => keys),
    makeWASocket,
    normalizeMessageContent: vi.fn<NormalizeMessageContentFn>((message) =>
      mockNormalizeMessageContent(message),
    ),
    useMultiFileAuthState: vi.fn<UseMultiFileAuthStateFn>(async () => ({
      state: { creds: {}, keys: {} } as Awaited<ReturnType<UseMultiFileAuthStateFn>>["state"],
      saveCreds: vi.fn(),
    })),
    jidToE164: (jid: string) => jid.replace(/@.*$/, "").replace(/^/, "+"),
    downloadMediaMessage: vi.fn<DownloadMediaMessageFn>().mockResolvedValue(Buffer.from("img")),
  };

  return {
    mod,
    lastSocket: () => {
      const last = sockets.at(-1);
      if (!last) {
        throw new Error("No Baileys sockets created");
      }
      return last;
    },
  };
}
