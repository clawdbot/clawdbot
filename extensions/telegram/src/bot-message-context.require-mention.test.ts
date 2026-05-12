import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultRouteConfig } = vi.hoisted(() => ({
  defaultRouteConfig: {
    agents: {
      list: [{ id: "main", default: true }],
    },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: vi.fn(() => defaultRouteConfig),
  };
});

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

describe("buildTelegramMessageContext requireMention precedence", () => {
  function buildForumMessage(threadId = 99) {
    return {
      message_id: 1,
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "Forum",
        is_forum: true,
      },
      date: 1_700_000_000,
      text: "hello everyone",
      message_thread_id: threadId,
      from: { id: 42, first_name: "Alice" },
    };
  }

  beforeEach(() => {
    vi.mocked(getRuntimeConfig).mockReturnValue(defaultRouteConfig as never);
  });

  it("lets explicit topic requireMention=false override group requireMention=true", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { requireMention: false },
      }),
    });

    if (!ctx) {
      throw new Error("expected Telegram context when topic disables requireMention");
    }
  });

  it("lets explicit topic requireMention=false override mention activation", async () => {
    const resolveGroupActivation = vi.fn(() => true);

    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { requireMention: false },
      }),
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram context payload when topic disables requireMention");
    }
    const activationCalls = resolveGroupActivation.mock.calls as unknown as Array<
      [{ chatId: number; messageThreadId?: number; sessionKey: string }]
    >;
    const [activationOptions] = activationCalls[0] ?? [];
    expect(activationOptions?.chatId).toBe(-1001234567890);
    expect(activationOptions?.messageThreadId).toBe(99);
    expect(activationOptions?.sessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
  });

  it("lets explicit topic requireMention=true override always activation", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { requireMention: true },
      }),
    });

    expect(ctx).toBeNull();
  });

  it("keeps activation fallback when no topic requireMention is configured", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { agentId: "main" },
      }),
    });

    if (!ctx) {
      throw new Error("expected Telegram context when topic config keeps agent");
    }
  });
});
