import { describe, expect, it, vi } from "vitest";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

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

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

import { createSignalEventHandler } from "./event-handler.js";

describe("signal mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: {
            signal: {
              groups: {
                "*": {
                  requireMention: true,
                  ingest: true,
                },
              },
            },
          },
        } as never,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello without mention",
          attachments: [],
          groupInfo: { groupId: "group-123", groupName: "Ops" },
        },
      }),
    );

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    const [type, action, sessionKey, context] =
      internalHookMocks.createInternalHookEvent.mock.calls[0] ?? [];
    expect(type).toBe("message");
    expect(action).toBe("received");
    expect(sessionKey).toContain("signal");
    expect(context).toEqual({
      from: "group:group-123",
      content: "hello without mention",
      timestamp: 1700000000000,
      channelId: "signal",
      accountId: "default",
      conversationId: "group:group-123",
      messageId: "1700000000000",
      metadata: {
        to: "group:group-123",
        provider: "signal",
        surface: "signal",
        threadId: undefined,
        senderId: "+15550001111",
        senderName: "Alice",
        senderUsername: undefined,
        senderE164: undefined,
        guildId: undefined,
        channelName: undefined,
        topicName: undefined,
      },
    });
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not emit when group ingest is false and wildcard ingest is true", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: {
            signal: {
              groups: {
                "group-123": {
                  requireMention: true,
                  ingest: false,
                },
                "*": {
                  requireMention: true,
                  ingest: true,
                },
              },
            },
          },
        } as never,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello without mention",
          attachments: [],
          groupInfo: { groupId: "group-123", groupName: "Ops" },
        },
      }),
    );

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });
});
