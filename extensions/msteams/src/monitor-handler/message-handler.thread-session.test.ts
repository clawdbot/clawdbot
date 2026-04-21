import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
} from "./message-handler.test-support.js";

vi.mock("../graph-thread.js", async () => {
  const actual = await vi.importActual<typeof import("../graph-thread.js")>("../graph-thread.js");
  return {
    ...actual,
    resolveTeamGroupId: vi.fn(async () => "group-1"),
    fetchChannelMessage: vi.fn(async () => undefined),
    fetchThreadReplies: vi.fn(async () => []),
  };
});

describe("msteams thread session isolation", () => {
  it("appends thread suffix to session key for channel thread replies", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    // Thread reply: has replyToId pointing to the thread root
    await handler({
      activity: buildChannelActivity({ replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).toContain("thread:");
    expect(sessionKey).toContain("thread-root-123");
  });

  it("does not append thread suffix for top-level channel messages", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    // Top-level channel message: no replyToId
    await handler({
      activity: buildChannelActivity({ replyToId: undefined }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
    expect(sessionKey).toBe(`agent:main:msteams:channel:${channelConversationId}`);
  });

  it("produces different session keys for different threads in the same channel", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({ id: "msg-1", replyToId: "thread-A" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    await handler({
      activity: buildChannelActivity({ id: "msg-2", replyToId: "thread-B" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(2);
    const sessionKeyA = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    const sessionKeyB = recordInboundSession.mock.calls[1]?.[0]?.sessionKey;
    expect(sessionKeyA).not.toBe(sessionKeyB);
    expect(sessionKeyA).toContain("thread-a"); // normalized lowercase
    expect(sessionKeyB).toContain("thread-b");
  });

  it("does not affect DM session keys", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...buildChannelActivity(),
        conversation: {
          id: "a:dm-conversation",
          conversationType: "personal",
        },
        channelData: {},
        replyToId: "some-reply-id",
        entities: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
  });

  it("does not affect group chat session keys", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...buildChannelActivity(),
        conversation: {
          id: "19:group-chat-id@unq.gbl.spaces",
          conversationType: "groupChat",
        },
        channelData: {},
        replyToId: "some-reply-id",
        entities: [{ type: "mention", mentioned: { id: "bot-id" } }],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
  });
});
