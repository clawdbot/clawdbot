import { describe, expect, it } from "vitest";
import { buzzPlugin } from "./channel.js";
import { buildBuzzMessageTags } from "./message-event.js";

const ROOM_ID = "64f4debf-e7af-438c-8dcd-d6fbbe77405d";

function requireBuzzToolContextBuilder() {
  const buildToolContext = buzzPlugin.threading?.buildToolContext;
  if (!buildToolContext) {
    throw new Error("Buzz threading.buildToolContext unavailable");
  }
  return buildToolContext;
}

function requireBuzzToolContextTargetMatcher() {
  const matchesToolContextTarget = buzzPlugin.threading?.matchesToolContextTarget;
  if (!matchesToolContextTarget) {
    throw new Error("Buzz threading.matchesToolContextTarget unavailable");
  }
  return matchesToolContextTarget;
}

function requireBuzzReplyTransportResolver() {
  const resolveReplyTransport = buzzPlugin.threading?.resolveReplyTransport;
  if (!resolveReplyTransport) {
    throw new Error("Buzz threading.resolveReplyTransport unavailable");
  }
  return resolveReplyTransport;
}

function requireBuzzAutoThreadResolver() {
  const resolveAutoThreadId = buzzPlugin.threading?.resolveAutoThreadId;
  if (!resolveAutoThreadId) {
    throw new Error("Buzz threading.resolveAutoThreadId unavailable");
  }
  return resolveAutoThreadId;
}

describe("Buzz channel guidance", () => {
  it("advertises directory room targets and native mention syntax", () => {
    const hints = buzzPlugin.agentPrompt?.messageToolHints?.({} as never) ?? [];

    expect(hints).toContain(
      "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
    );
    expect(hints).toContain(
      "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
    );
    expect(buzzPlugin.messaging?.targetResolver?.hint).toBe("<room UUID|configured room name>");
  });

  it("resolves Buzz reply sessions without treating the thread as part of the room UUID", () => {
    const threadId = "584e8d00bab48310ea80ff5f62550f824242bbc333fc4c259d7ae80be025c8aa";

    expect(
      buzzPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: `buzz:${ROOM_ID}:thread:${threadId}`,
      }),
    ).toEqual({
      id: ROOM_ID,
      threadId,
      baseConversationId: ROOM_ID,
      parentConversationCandidates: [ROOM_ID],
    });
  });

  it("collapses a model-supplied current-trigger reply to the Buzz root", () => {
    const rootId = "root-event";
    const triggerId = "child-event";
    const toolContext = requireBuzzToolContextBuilder()({
      cfg: {},
      context: {
        To: `buzz:${ROOM_ID}`,
        CurrentMessageId: triggerId,
        ReplyToId: rootId,
        MessageThreadId: rootId,
      },
    });

    expect(toolContext).toMatchObject({
      currentChannelId: ROOM_ID,
      currentMessagingTarget: `buzz:${ROOM_ID}`,
      currentThreadTs: rootId,
      currentMessageId: triggerId,
      replyToMode: "all",
    });
    const transport = requireBuzzReplyTransportResolver()({
      cfg: {},
      threadId: rootId,
      replyToId: triggerId,
      replyToIsExplicit: true,
      toolContext,
    });

    expect(transport).toEqual({ replyToId: rootId, threadId: rootId });
    expect(
      buildBuzzMessageTags({
        channelId: ROOM_ID,
        threadId: String(transport?.threadId),
        replyToId: String(transport?.replyToId),
      }),
    ).toEqual([
      ["h", ROOM_ID],
      ["e", rootId, "", "reply"],
    ]);
  });

  it.each([ROOM_ID, `buzz:${ROOM_ID}`, `channel:${ROOM_ID}`, ROOM_ID.toUpperCase()])(
    "matches the current Buzz room after target normalization: %s",
    (target) => {
      expect(
        requireBuzzToolContextTargetMatcher()({
          target,
          toolContext: {
            currentChannelId: ROOM_ID,
            currentMessagingTarget: `buzz:${ROOM_ID}`,
          },
        }),
      ).toBe(true);
    },
  );

  it("does not match a different Buzz room", () => {
    expect(
      requireBuzzToolContextTargetMatcher()({
        target: "f7568b5f-9d25-4a4f-a38a-2c41440fc9cd",
        toolContext: {
          currentChannelId: ROOM_ID,
          currentMessagingTarget: `buzz:${ROOM_ID}`,
        },
      }),
    ).toBe(false);
  });

  it("inherits the Buzz root only for the current room", () => {
    const resolveAutoThreadId = requireBuzzAutoThreadResolver();
    const toolContext = {
      currentChannelId: ROOM_ID,
      currentMessagingTarget: `buzz:${ROOM_ID}`,
      currentThreadTs: "root-event",
    };

    expect(resolveAutoThreadId({ cfg: {}, to: ROOM_ID, toolContext })).toBe("root-event");
    expect(
      resolveAutoThreadId({
        cfg: {},
        to: "f7568b5f-9d25-4a4f-a38a-2c41440fc9cd",
        toolContext,
      }),
    ).toBeUndefined();
  });

  it("uses all-replies threading policy for Buzz message tools", () => {
    expect(
      buzzPlugin.threading?.resolveReplyToMode?.({
        cfg: {},
        accountId: "default",
        chatType: "group",
      }),
    ).toBe("all");
  });

  it("preserves an explicit nested message-tool reply inside the Buzz root", () => {
    const rootId = "root-event";
    const triggerId = "trigger-event";
    const otherChildId = "other-child-event";
    const toolContext = requireBuzzToolContextBuilder()({
      cfg: {},
      context: {
        To: `buzz:${ROOM_ID}`,
        CurrentMessageId: triggerId,
        ReplyToId: rootId,
        MessageThreadId: rootId,
      },
    });
    const transport = requireBuzzReplyTransportResolver()({
      cfg: {},
      threadId: rootId,
      replyToId: otherChildId,
      replyToIsExplicit: true,
      toolContext,
    });

    expect(transport).toEqual({ replyToId: otherChildId, threadId: rootId });
    expect(
      buildBuzzMessageTags({
        channelId: ROOM_ID,
        threadId: String(transport?.threadId),
        replyToId: String(transport?.replyToId),
      }),
    ).toEqual([
      ["h", ROOM_ID],
      ["e", rootId, "", "root"],
      ["e", otherChildId, "", "reply"],
    ]);
  });

  it("keeps top-level Buzz tool context outside a thread", () => {
    const rootId = "root-event";
    const toolContext = requireBuzzToolContextBuilder()({
      cfg: {},
      context: {
        To: `buzz:${ROOM_ID}`,
        CurrentMessageId: rootId,
        ReplyToId: rootId,
      },
    });

    expect(toolContext).toMatchObject({
      currentChannelId: ROOM_ID,
      currentMessagingTarget: `buzz:${ROOM_ID}`,
      currentMessageId: rootId,
      currentThreadTs: undefined,
      replyToMode: "all",
    });
    expect(
      buildBuzzMessageTags({
        channelId: ROOM_ID,
        replyToId: String(toolContext?.currentMessageId),
      }),
    ).toEqual([
      ["h", ROOM_ID],
      ["e", rootId, "", "reply"],
    ]);
  });

  it.each([
    { name: "implicit root reply", replyToId: "root-event", threadId: "root-event" },
    { name: "explicit nested reply", replyToId: "child-event", threadId: "root-event" },
  ])("keeps the base room session for $name", async ({ replyToId, threadId }) => {
    const resolveRoute = buzzPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("Buzz messaging.resolveOutboundSessionRoute unavailable");
    }
    const baseParams = {
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: `buzz:${ROOM_ID}`,
    };
    const topLevelRoute = await resolveRoute(baseParams);
    const replyRoute = await resolveRoute({
      ...baseParams,
      replyToId,
      threadId,
      currentSessionKey: topLevelRoute?.sessionKey,
    });

    expect(replyRoute).toEqual(topLevelRoute);
    expect(replyRoute?.sessionKey).not.toContain(":thread:");
  });
});
