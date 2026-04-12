import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", () => {
  return {
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    fireAndForgetHook: (task: Promise<unknown>) => void task,
    toInternalMessageReceivedContext: (context: Record<string, unknown>) => ({
      ...context,
      metadata: { to: context.to },
    }),
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

function makeGroupMessage(text: string) {
  return {
    message_id: 42,
    chat: { id: -1001234567890, type: "supergroup" as const, title: "Test Group" },
    date: 1_700_000_000,
    text,
    from: { id: 99, first_name: "Alice", username: "alice" },
  };
}

describe("telegram mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const result = await buildTelegramMessageContextForTest({
      message: makeGroupMessage("hello without mention"),
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/sonnet-4.6",
            workspace: "/tmp/openclaw",
          },
        },
        channels: {
          telegram: {
            groups: {
              "*": {
                requireMention: true,
                ingest: true,
              },
            },
          },
        },
        messages: {
          groupChat: {
            mentionPatterns: ["@bot"],
          },
        },
      } as never,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: true,
          ingest: true,
        },
        topicConfig: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("telegram"),
      expect.objectContaining({
        channelId: "telegram",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("uses wildcard ingest when a specific group override omits ingest", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const result = await buildTelegramMessageContextForTest({
      message: makeGroupMessage("hello without mention"),
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/sonnet-4.6",
            workspace: "/tmp/openclaw",
          },
        },
        channels: {
          telegram: {
            groups: {
              "*": {
                requireMention: true,
                ingest: true,
              },
              "-1001234567890": {
                requireMention: true,
              },
            },
          },
        },
        messages: {
          groupChat: {
            mentionPatterns: ["@bot"],
          },
        },
      } as never,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: true,
        },
        topicConfig: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("telegram"),
      expect.objectContaining({
        channelId: "telegram",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });
});
