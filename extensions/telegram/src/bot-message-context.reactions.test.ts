import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";

type InboundBodyMock = (arg: unknown) => Promise<{
  bodyText: string;
  rawBody: string;
  historyKey: undefined;
  commandAuthorized: boolean;
  effectiveWasMentioned: boolean;
  canDetectMention: boolean;
  shouldBypassMention: boolean;
  stickerCacheHit: boolean;
  locationData: undefined;
}>;

const inboundBodyMock = vi.hoisted(() =>
  vi.fn<InboundBodyMock>(async () => ({
    bodyText: "hello",
    rawBody: "hello",
    historyKey: undefined,
    commandAuthorized: false,
    effectiveWasMentioned: false,
    canDetectMention: true,
    shouldBypassMention: false,
    stickerCacheHit: false,
    locationData: undefined,
  })),
);

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
