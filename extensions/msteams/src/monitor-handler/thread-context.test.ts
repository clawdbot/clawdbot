// Msteams tests cover inbound channel conversation routing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "../runtime.js";
import { prepareMSTeamsThreadRouting } from "./thread-context.js";

describe("prepareMSTeamsThreadRouting", () => {
  const channelSessionKey = "agent:main:msteams:channel:19:channel@thread.tacv2";
  const resolveAgentRoute = vi.fn(() => ({
    agentId: "main",
    accountId: "default",
    sessionKey: channelSessionKey,
    baseSessionKey: channelSessionKey,
  }));

  beforeEach(() => {
    resolveAgentRoute.mockClear();
    setMSTeamsRuntime({
      channel: { routing: { resolveAgentRoute } },
    } as never);
  });

  it("keeps channel replies on the channel conversation session when configured", () => {
    const routing = prepareMSTeamsThreadRouting({
      cfg: {},
      context: {
        activity: {
          replyToId: "thread-root",
          channelData: {},
        },
      } as never,
      isDirectMessage: false,
      isChannel: true,
      senderId: "sender-1",
      conversationId: "19:channel@thread.tacv2",
      conversationMessageId: "thread-root",
      threadSessionPolicy: "channel",
      teamId: "team-1",
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(routing.route.sessionKey).toBe(channelSessionKey);
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "channel", id: "19:channel@thread.tacv2" },
      }),
    );
  });

  it("isolates channel replies by thread by default", () => {
    const routing = prepareMSTeamsThreadRouting({
      cfg: {},
      context: {
        activity: {
          replyToId: "thread-root",
          channelData: {},
        },
      } as never,
      isDirectMessage: false,
      isChannel: true,
      senderId: "sender-1",
      conversationId: "19:channel@thread.tacv2",
      conversationMessageId: "thread-root",
      threadSessionPolicy: "thread",
      teamId: "team-1",
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(routing.route.sessionKey).toBe(`${channelSessionKey}:thread:thread-root`);
  });
});
