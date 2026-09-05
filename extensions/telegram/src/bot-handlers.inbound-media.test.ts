import type { Message } from "grammy/types";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramMediaGroupInput } from "./bot-handlers.inbound-media.types.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramContext } from "./bot/types.js";
import { MediaFetchError } from "./telegram-media.runtime.js";

const resolveMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./bot/delivery.resolve-media.js", () => ({
  resolveMedia: resolveMediaMock,
}));

const { createTelegramInboundMedia } = await import("./bot-handlers.inbound-media.js");

const emptyAllow = {
  entries: [],
  hasEntries: false,
  hasWildcard: false,
  invalidEntries: [],
};

function createAlbumMessage(messageId: number): Message {
  return {
    message_id: messageId,
    date: 2_000_000_000,
    chat: { id: 42, type: "private", first_name: "Test" },
    from: { id: 9, is_bot: false, first_name: "Sender" },
    media_group_id: "partial-warning-race",
    photo: [
      {
        file_id: `photo-${messageId}`,
        file_unique_id: `photo-unique-${messageId}`,
        width: 1,
        height: 1,
      },
    ],
  };
}

function createContext(msg: Message): TelegramContext {
  return {
    message: msg,
    me: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
  } as TelegramContext;
}

function createAlbumInput(msg: Message): TelegramMediaGroupInput {
  return {
    ctx: createContext(msg),
    msg,
    authorizationCfg: { commands: { native: true } },
    chatId: msg.chat.id,
    isGroup: false,
    isForum: false,
    threadSpec: { scope: "none" },
    senderId: String(msg.from?.id ?? "unknown"),
    effectiveGroupAllow: emptyAllow,
    effectiveDmAllow: emptyAllow,
    ignoreEnabled: true,
    storeAllowFrom: [],
    dispatchDedupeClaims: [],
    channelIngressResolvers: [],
  };
}

describe("createTelegramInboundMedia", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not send a partial-album warning when an edit cancels before admission", async () => {
    vi.useFakeTimers();
    const enteredDispatchBoundary =
      createDeferred<Parameters<TelegramMessagePipeline["processMessageWithReplyChain"]>[0]>();
    const releaseDispatchBoundary = createDeferred<void>();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const processMessageWithReplyChain = vi.fn(
      async (input: Parameters<TelegramMessagePipeline["processMessageWithReplyChain"]>[0]) => {
        enteredDispatchBoundary.resolve(input);
        await releaseDispatchBoundary.promise;
        if (await input.shouldSkipBeforeDispatch?.()) {
          return { kind: "skipped" } as const;
        }
        if (input.dispatchAdmission?.tryAdmit() === false) {
          return { kind: "skipped" } as const;
        }
        await input.dispatchAdmission?.onAdmitted?.();
        return { kind: "completed" } as const;
      },
    );
    const removeMessageFromReplyChain = vi.fn(async () => true);
    const removeMessageFromGroupHistory = vi.fn(() => true);
    const message = {
      resolveMediaRuntime: (...signals: AbortSignal[]) => ({ abortSignal: signals[0] }),
      recordMessageResolvedMedia: vi.fn(async () => undefined),
      recordMessageForReplyChain: vi.fn(async () => undefined),
      removeMessageFromReplyChain,
      promptContextBoundaryOptions: () => ({}),
      latestPromptContextMinTimestampMs: (left?: number, right?: number) => right ?? left,
      latestPromptContextAmbientWatermark: (left?: unknown, right?: unknown) => right ?? left,
      mergeDispatchDedupeClaims: () => [],
      releaseDispatchDedupeClaims: vi.fn(),
      buildFailedProcessingResult: (error: unknown) => ({ kind: "failed-retryable", error }),
      settleSpooledReplayParticipants: vi.fn(),
      createSpooledReplayParticipantForBufferedWork: () => undefined,
      spooledReplayOptions: () => ({}),
      resolveTelegramSessionState: vi.fn(),
      processMessageWithReplyChain,
    } as unknown as TelegramMessagePipeline;
    const inboundMedia = createTelegramInboundMedia({
      params: {
        accountId: "default",
        bot: { api: { sendMessage } },
        opts: {
          token: "test-token",
          botInfo: { id: 7, username: "openclaw_bot" },
          testTimings: { mediaGroupFlushMs: 10 },
        },
        runtime: {},
        mediaMaxBytes: 10_000_000,
        logger: { info: vi.fn(), warn: vi.fn() },
        removeMessageFromGroupHistory,
        resolveGroupActivation: () => undefined,
        resolveGroupRequireMention: () => false,
      } as unknown as Pick<
        RegisterTelegramHandlerParams,
        | "accountId"
        | "bot"
        | "opts"
        | "runtime"
        | "mediaMaxBytes"
        | "logger"
        | "removeMessageFromGroupHistory"
        | "resolveGroupActivation"
        | "resolveGroupRequireMention"
      >,
      message,
    });
    resolveMediaMock
      .mockResolvedValueOnce({
        id: "media-1",
        fileUniqueId: "unique-1",
        path: "/tmp/media-1.jpg",
        size: 1,
        savedAt: Date.now(),
        kind: "image",
        contentType: "image/jpeg",
      })
      .mockRejectedValueOnce(new MediaFetchError("fetch_failed", "unavailable"));

    const first = createAlbumMessage(100);
    const second = createAlbumMessage(101);
    expect(inboundMedia.handleMediaGroup(createAlbumInput(first))).toBe(true);
    expect(inboundMedia.handleMediaGroup(createAlbumInput(second))).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    const boundary = await enteredDispatchBoundary.promise;
    expect(boundary.dispatchAdmission?.onAdmitted).toBeTypeOf("function");
    expect(sendMessage).not.toHaveBeenCalled();

    const pendingIgnore = inboundMedia.beginPendingMediaGroupIgnore({
      ...second,
      caption: "/ignore hidden",
      caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });
    expect(pendingIgnore).toBeDefined();
    const settling = pendingIgnore?.settle(true);
    releaseDispatchBoundary.resolve();

    await expect(settling).resolves.toBe(true);
    expect(processMessageWithReplyChain).toHaveBeenCalledOnce();
    expect(removeMessageFromReplyChain).toHaveBeenCalledTimes(4);
    expect(removeMessageFromGroupHistory).toHaveBeenCalledTimes(4);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("retains an admitted album owner while /ignore authorization is pending", async () => {
    vi.useFakeTimers();
    resolveMediaMock.mockReset();
    resolveMediaMock.mockResolvedValue({
      id: "media-1",
      fileUniqueId: "photo-unique-100",
      path: "/tmp/media-1.jpg",
      size: 1,
      savedAt: Date.now(),
      kind: "image",
      contentType: "image/jpeg",
    });
    const removeMessageFromReplyChain = vi.fn(async () => true);
    const removeMessageFromGroupHistory = vi.fn(() => true);
    const processMessageWithReplyChain = vi.fn(
      async (input: Parameters<TelegramMessagePipeline["processMessageWithReplyChain"]>[0]) => {
        expect(input.dispatchAdmission?.tryAdmit()).toBe(true);
        return { kind: "completed" } as const;
      },
    );
    const message = {
      resolveMediaRuntime: (...signals: AbortSignal[]) => ({ abortSignal: signals[0] }),
      recordMessageResolvedMedia: vi.fn(async () => undefined),
      recordMessageForReplyChain: vi.fn(async () => undefined),
      removeMessageFromReplyChain,
      promptContextBoundaryOptions: () => ({}),
      latestPromptContextMinTimestampMs: (left?: number, right?: number) => right ?? left,
      latestPromptContextAmbientWatermark: (left?: unknown, right?: unknown) => right ?? left,
      mergeDispatchDedupeClaims: () => [],
      releaseDispatchDedupeClaims: vi.fn(),
      buildFailedProcessingResult: (error: unknown) => ({ kind: "failed-retryable", error }),
      settleSpooledReplayParticipants: vi.fn(),
      createSpooledReplayParticipantForBufferedWork: () => undefined,
      spooledReplayOptions: () => ({}),
      resolveTelegramSessionState: vi.fn(),
      processMessageWithReplyChain,
    } as unknown as TelegramMessagePipeline;
    const inboundMedia = createTelegramInboundMedia({
      params: {
        accountId: "default",
        bot: { api: { sendMessage: vi.fn() } },
        opts: {
          token: "test-token",
          botInfo: { id: 7, username: "openclaw_bot" },
          testTimings: { mediaGroupFlushMs: 10 },
        },
        runtime: {},
        mediaMaxBytes: 10_000_000,
        logger: { info: vi.fn(), warn: vi.fn() },
        removeMessageFromGroupHistory,
        resolveGroupActivation: () => undefined,
        resolveGroupRequireMention: () => false,
      } as unknown as Pick<
        RegisterTelegramHandlerParams,
        | "accountId"
        | "bot"
        | "opts"
        | "runtime"
        | "mediaMaxBytes"
        | "logger"
        | "removeMessageFromGroupHistory"
        | "resolveGroupActivation"
        | "resolveGroupRequireMention"
      >,
      message,
    });
    const albumMessage = createAlbumMessage(100);

    expect(inboundMedia.handleMediaGroup(createAlbumInput(albumMessage))).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(processMessageWithReplyChain).toHaveBeenCalledOnce();
    const pendingIgnore = inboundMedia.beginPendingMediaGroupIgnore({
      ...albumMessage,
      caption: "/ignore hidden",
      caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });
    expect(pendingIgnore).toBeDefined();

    // Cross the admitted owner's original retention deadline before authorization resolves.
    await vi.advanceTimersByTimeAsync(11);
    await expect(pendingIgnore?.settle(true)).resolves.toBe(false);
    expect(removeMessageFromReplyChain).toHaveBeenCalledWith(albumMessage);

    removeMessageFromReplyChain.mockClear();
    removeMessageFromGroupHistory.mockClear();
    const repeatedIgnore = inboundMedia.beginPendingMediaGroupIgnore({
      ...albumMessage,
      caption: "/ignore hidden again",
      caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });
    await expect(repeatedIgnore?.settle(true)).resolves.toBe(false);
    expect(removeMessageFromReplyChain).not.toHaveBeenCalled();
    expect(removeMessageFromGroupHistory).not.toHaveBeenCalled();
  });
});
