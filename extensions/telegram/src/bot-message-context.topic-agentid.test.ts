import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultRouteConfig } = vi.hoisted(() => ({
  defaultRouteConfig: {
    agents: {
      list: [{ id: "main", default: true }, { id: "zu" }, { id: "q" }, { id: "support" }],
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

describe("buildTelegramMessageContext per-topic agentId routing", () => {
  function buildForumMessage(threadId = 3) {
    return {
      message_id: 1,
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "Forum",
        is_forum: true,
      },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: threadId,
      from: { id: 42, first_name: "Alice" },
    };
  }

  async function buildForumContext(params: {
    threadId?: number;
    topicConfig?: Record<string, unknown>;
  }) {
    return await buildTelegramMessageContextForTest({
      message: buildForumMessage(params.threadId),
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        ...(params.topicConfig ? { topicConfig: params.topicConfig } : {}),
      }),
    });
  }

  beforeEach(() => {
    vi.mocked(getRuntimeConfig).mockReturnValue(defaultRouteConfig as never);
  });

  it("uses group-level agent when no topic agentId is set", async () => {
    const ctx = await buildForumContext({ topicConfig: { systemPrompt: "Be nice" } });

    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:3");
  });

  it("routes to topic-specific agent when agentId is set", async () => {
    const ctx = await buildForumContext({
      topicConfig: { agentId: "zu", systemPrompt: "I am Zu" },
    });

    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:zu:");
    expect(ctx?.ctxPayload?.SessionKey).toContain("telegram:group:-1001234567890:topic:3");
  });

  it("different topics route to different agents", async () => {
    const buildForTopic = async (threadId: number, agentId: string) =>
      await buildForumContext({ threadId, topicConfig: { agentId } });

    const ctxA = await buildForTopic(1, "main");
    const ctxB = await buildForTopic(3, "zu");
    const ctxC = await buildForTopic(5, "q");

    expect(ctxA?.ctxPayload?.SessionKey).toContain("agent:main:");
    expect(ctxB?.ctxPayload?.SessionKey).toContain("agent:zu:");
    expect(ctxC?.ctxPayload?.SessionKey).toContain("agent:q:");

    expect(ctxA?.ctxPayload?.SessionKey).not.toBe(ctxB?.ctxPayload?.SessionKey);
    expect(ctxB?.ctxPayload?.SessionKey).not.toBe(ctxC?.ctxPayload?.SessionKey);
  });

  it("ignores whitespace-only agentId and uses group-level agent", async () => {
    const ctx = await buildForumContext({
      topicConfig: { agentId: "   ", systemPrompt: "Be nice" },
    });

    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:main:");
  });

  it("preserves an unknown topic agentId in the session key", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      agents: {
        list: [{ id: "main", default: true }, { id: "zu" }],
      },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
    } as never);

    const ctx = await buildForumContext({ topicConfig: { agentId: "ghost" } });

    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:ghost:");
  });

  it("routes DM topic to specific agent when agentId is set", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: {
          id: 123456789,
          type: "private",
        },
        date: 1700000000,
        text: "@bot hello",
        message_thread_id: 99,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "support", systemPrompt: "I am support" },
      }),
    });

    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:support:");
  });
});
