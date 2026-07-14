// Telegram tests cover bot message context.reactions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";

type ResolveTelegramInboundBody =
  typeof import("./bot-message-context.body.js").resolveTelegramInboundBody;
type TelegramInboundBodyResult = NonNullable<Awaited<ReturnType<ResolveTelegramInboundBody>>>;

type InboundBodyMock = (arg: unknown) => Promise<TelegramInboundBodyResult>;

const { createInboundBodyResult, inboundBodyMock } = vi.hoisted(() => {
  const buildInboundBodyResult = (
    inboundEventKind: TelegramInboundBodyResult["inboundEventKind"] = "user_request",
  ): TelegramInboundBodyResult => ({
    bodyText: "hello",
    rawBody: "hello",
    historyKey: undefined,
    commandAuthorized: false,
    effectiveWasMentioned: false,
    inboundEventKind,
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: false,
      effectiveWasMentioned: false,
      requireMention: false,
      shouldSkip: false,
    },
    canDetectMention: true,
    shouldBypassMention: false,
    hasControlCommand: false,
    stickerCacheHit: false,
    locationData: undefined,
  });

  return {
    createInboundBodyResult: buildInboundBodyResult,
    inboundBodyMock: vi.fn<InboundBodyMock>(async () => buildInboundBodyResult()),
  };
});

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: (arg: unknown) => inboundBodyMock(arg),
}));

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

type CreateStatusReactionController = NonNullable<
  NonNullable<BuildTelegramMessageContextParams["runtime"]>["createStatusReactionController"]
>;
type StatusReactionControllerParams = Parameters<CreateStatusReactionController>[0];

function createStatusReactionControllerStub() {
  const controller = {
    setQueued: vi.fn(async () => undefined),
    setThinking: vi.fn(async () => undefined),
    setTool: vi.fn(async () => undefined),
    setCompacting: vi.fn(async () => undefined),
    cancelPending: vi.fn(),
    setDone: vi.fn(async () => undefined),
    setError: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    restoreInitial: vi.fn(async () => undefined),
  };
  const createStatusReactionController = vi.fn((_params: StatusReactionControllerParams) => {
    return controller;
  });
  return { controller, createStatusReactionController };
}

describe("buildTelegramMessageContext reactions", () => {
  beforeEach(() => {
    inboundBodyMock.mockClear();
  });

  it("does not create ack or status reactions for room events when scope does not force all messages", async () => {
    const setMessageReaction = vi.fn(async () => undefined);
    const { createStatusReactionController } = createStatusReactionControllerStub();
    inboundBodyMock.mockResolvedValueOnce(createInboundBodyResult("room_event"));

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 12,
        chat: { id: -1001234567890, type: "group", title: "Ops" },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      cfg: {
        agents: {
          defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" },
        },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
        messages: {
          ackReaction: "👀",
          groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] },
          statusReactions: { enabled: true },
        },
      },
      ackReactionScope: "group-all",
      botApi: { setMessageReaction },
      runtime: { createStatusReactionController },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
    expect(ctx?.ackReactionPromise).toBeNull();
    expect(ctx?.statusReactionController).toBeNull();
    expect(createStatusReactionController).not.toHaveBeenCalled();
    expect(setMessageReaction).not.toHaveBeenCalled();
  });

  it("sends Telegram ack reactions for room events when ack scope is all", async () => {
    const setMessageReaction = vi.fn(async () => undefined);
    const { createStatusReactionController } = createStatusReactionControllerStub();
    inboundBodyMock.mockResolvedValueOnce(createInboundBodyResult("room_event"));

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 12,
        chat: { id: -1001234567890, type: "group", title: "Ops" },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      cfg: {
        agents: {
          defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" },
        },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
        messages: {
          ackReaction: "👀",
          groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] },
          statusReactions: { enabled: true },
        },
      },
      ackReactionScope: "all",
      botApi: { setMessageReaction },
      runtime: { createStatusReactionController },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
    await expect(ctx?.ackReactionPromise).resolves.toBe(true);
    expect(ctx?.statusReactionController).toBeNull();
    expect(createStatusReactionController).not.toHaveBeenCalled();
    expect(setMessageReaction).toHaveBeenCalledWith(-1001234567890, 12, [
      { type: "emoji", emoji: "👀" },
    ]);
  });

  it("does not create status reactions when the ack gate blocks an unmentioned group message", async () => {
    const setMessageReaction = vi.fn(async () => undefined);
    const { createStatusReactionController } = createStatusReactionControllerStub();

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 12,
        chat: { id: -1001234567890, type: "group", title: "Ops" },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      cfg: {
        agents: {
          defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" },
        },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
        messages: {
          ackReaction: "👀",
          groupChat: { mentionPatterns: [] },
          statusReactions: { enabled: true },
        },
      },
      ackReactionScope: "group-mentions",
      botApi: { setMessageReaction },
      runtime: { createStatusReactionController },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ackReactionPromise).toBeNull();
    expect(ctx?.statusReactionController).toBeNull();
    expect(createStatusReactionController).not.toHaveBeenCalled();
    expect(setMessageReaction).not.toHaveBeenCalled();
  });

  it("keeps Telegram status reaction variants available for configured emoji fallbacks", async () => {
    const setMessageReaction = vi.fn(async () => undefined);
    const { controller, createStatusReactionController } = createStatusReactionControllerStub();

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 34,
        chat: {
          id: 1234,
          type: "private",
          available_reactions: [{ type: "emoji", emoji: "👍" }],
        },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      cfg: {
        agents: {
          defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" },
        },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
        messages: {
          ackReaction: "👀",
          groupChat: { mentionPatterns: [] },
          statusReactions: {
            enabled: true,
            emojis: { done: "✅" },
          },
        },
      },
      ackReactionScope: "direct",
      botApi: { setMessageReaction },
      runtime: { createStatusReactionController },
    });

    await expect(ctx?.ackReactionPromise).resolves.toBe(true);
    expect(controller.setQueued).toHaveBeenCalledTimes(1);
    expect(createStatusReactionController).toHaveBeenCalledTimes(1);

    const params = createStatusReactionController.mock.calls.at(0)?.[0];
    expect(params?.initialEmoji).toBe("👀");
    expect(params?.emojis?.done).toBe("✅");

    await params?.adapter.setReaction("✅");

    expect(setMessageReaction).toHaveBeenCalledWith(1234, 34, [{ type: "emoji", emoji: "👍" }]);
  });
});
