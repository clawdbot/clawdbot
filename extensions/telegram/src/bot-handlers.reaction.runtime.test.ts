// Telegram tests cover forum reaction topic recovery before authorization and routing.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramHandlerAuthorizationRuntime } from "./bot-handlers.authorization.runtime.js";
import { registerTelegramReactionHandler } from "./bot-handlers.reaction.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";

const FIRE_EMOJI = "\u{1F525}";
const FORUM_CHAT_ID = 5678;
const FORUM_TOPIC_ID = 77;
const REACTED_MESSAGE_ID = 100;

type ReactionHandler = (ctx: Record<string, unknown>) => Promise<void>;

const enqueueSystemEvent = vi.fn();
const runtimeLog = vi.fn();
const runtimeError = vi.fn();
const resolveCachedMessageThreadId = vi.fn<
  (params: { chatId: number | string; messageId: number | string }) => Promise<number | undefined>
>(async () => undefined);

function buildTelegramConfig(overrides?: {
  topics?: Record<string, { enabled?: boolean; agentId?: string }>;
}): OpenClawConfig {
  return {
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        reactionNotifications: "all",
        groupPolicy: "open",
        groups: {
          [String(FORUM_CHAT_ID)]: {
            enabled: true,
            ...(overrides?.topics ? { topics: overrides.topics } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
}

/**
 * Registers the real reaction handler against the real authorization runtime so
 * the test proves topic-scoped config lookup, not just the handler's own branch.
 */
function registerHandler(cfg: OpenClawConfig): ReactionHandler {
  const handlers = new Map<string, ReactionHandler>();
  const params: RegisterTelegramHandlerParams = {
    accountId: "default",
    bot: {
      on: (name: string, handler: ReactionHandler) => {
        handlers.set(name, handler);
      },
    } as RegisterTelegramHandlerParams["bot"],
    cfg,
    mediaMaxBytes: 1,
    opts: { token: "tok" },
    telegramCfg: {},
    logger: getChildLogger({ module: "telegram/reaction-test" }),
    runtime: { log: runtimeLog, error: runtimeError, exit: vi.fn() },
    shouldSkipUpdate: () => false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: (
      chatId: string | number,
      messageThreadId: number | undefined,
      config: OpenClawConfig,
    ) => {
      const groups = (
        config.channels?.telegram as
          | {
              groups?: Record<
                string,
                {
                  enabled?: boolean;
                  topics?: Record<string, { enabled?: boolean; agentId?: string }>;
                }
              >;
            }
          | undefined
      )?.groups;
      const groupConfig = groups?.[String(chatId)];
      return {
        groupConfig,
        topicConfig:
          messageThreadId === undefined
            ? undefined
            : groupConfig?.topics?.[String(messageThreadId)],
      };
    },
    processMessage: vi.fn<RegisterTelegramHandlerParams["processMessage"]>(),
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      wasSentByBot: () => true,
      enqueueSystemEvent,
      readChannelAllowFromStore: async () => [],
    },
  };

  registerTelegramReactionHandler(
    params,
    { resolveCachedMessageThreadId },
    createTelegramHandlerAuthorizationRuntime(params),
  );
  const handler = handlers.get("message_reaction");
  if (!handler) {
    throw new Error("expected message_reaction handler");
  }
  return handler;
}

function forumReactionContext(overrides?: {
  oldReaction?: Array<{ type: string; emoji: string }>;
  newReaction?: Array<{ type: string; emoji: string }>;
  isForum?: boolean;
  chatType?: string;
}) {
  return {
    update: { update_id: 900 },
    messageReaction: {
      chat: {
        id: FORUM_CHAT_ID,
        type: overrides?.chatType ?? "supergroup",
        ...(overrides?.isForum === false ? {} : { is_forum: true }),
      },
      message_id: REACTED_MESSAGE_ID,
      user: { id: 10, first_name: "Bob", username: "bob_user" },
      date: 1736380800,
      old_reaction: overrides?.oldReaction ?? [],
      new_reaction: overrides?.newReaction ?? [{ type: "emoji", emoji: FIRE_EMOJI }],
    },
  };
}

function systemEventOptions(): { sessionKey?: string; contextKey?: string } {
  return (enqueueSystemEvent.mock.calls[0]?.[1] ?? {}) as {
    sessionKey?: string;
    contextKey?: string;
  };
}

describe("registerTelegramReactionHandler forum topic recovery", () => {
  beforeEach(() => {
    enqueueSystemEvent.mockClear();
    runtimeLog.mockClear();
    runtimeError.mockClear();
    resolveCachedMessageThreadId.mockReset();
    resolveCachedMessageThreadId.mockResolvedValue(undefined);
  });

  it("recovers the cached topic before authorization and routes to that topic", async () => {
    resolveCachedMessageThreadId.mockResolvedValue(FORUM_TOPIC_ID);
    const handler = registerHandler(
      buildTelegramConfig({ topics: { [String(FORUM_TOPIC_ID)]: { enabled: true } } }),
    );

    await handler(forumReactionContext());

    expect(resolveCachedMessageThreadId).toHaveBeenCalledWith({
      chatId: FORUM_CHAT_ID,
      messageId: REACTED_MESSAGE_ID,
    });
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).toContain(
      `telegram:group:${FORUM_CHAT_ID}:topic:${FORUM_TOPIC_ID}`,
    );
  });

  it("routes a recovered topic through its configured topic agent", async () => {
    resolveCachedMessageThreadId.mockResolvedValue(FORUM_TOPIC_ID);
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { [String(FORUM_TOPIC_ID)]: { enabled: true, agentId: "topicbot" } },
      }),
    );

    await handler(forumReactionContext());

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).toContain("topicbot");
  });

  it("applies the recovered topic's disabled config instead of the General topic's", async () => {
    resolveCachedMessageThreadId.mockResolvedValue(FORUM_TOPIC_ID);
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { "1": { enabled: true }, [String(FORUM_TOPIC_ID)]: { enabled: false } },
      }),
    );

    await handler(forumReactionContext());

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("drops a forum reaction with an unknown topic instead of guessing General", async () => {
    resolveCachedMessageThreadId.mockResolvedValue(undefined);
    const handler = registerHandler(buildTelegramConfig({ topics: { "1": { enabled: true } } }));

    await handler(forumReactionContext());

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    const logged = String(runtimeLog.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("thread-context-unavailable");
    expect(logged).toContain(`chat=${FORUM_CHAT_ID}`);
    expect(logged).toContain(`message=${REACTED_MESSAGE_ID}`);
    // Bounded degradation: route ids only, never message content or display names.
    expect(logged).not.toContain("bob_user");
    expect(logged).not.toContain(FIRE_EMOJI);
  });

  it("never consults the message cache for non-forum groups", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false }));

    expect(resolveCachedMessageThreadId).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).not.toContain(":topic:");
  });

  it("never consults the message cache for direct chats", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false, chatType: "private" }));

    expect(resolveCachedMessageThreadId).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).not.toContain(":topic:");
    expect(String(systemEventOptions().sessionKey)).not.toContain(":group:");
  });

  it("skips the cache lookup entirely when no reaction was added", async () => {
    const handler = registerHandler(
      buildTelegramConfig({ topics: { [String(FORUM_TOPIC_ID)]: { enabled: true } } }),
    );

    // A removal-only update enqueues nothing, so it must not spend a cache lookup
    // or log an unresolved-topic warning.
    await handler(
      forumReactionContext({
        oldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newReaction: [],
      }),
    );

    expect(resolveCachedMessageThreadId).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtimeLog).not.toHaveBeenCalled();
  });
});
