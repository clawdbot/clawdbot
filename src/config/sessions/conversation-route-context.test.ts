import { describe, expect, it } from "vitest";
import {
  conversationRouteContextFromMsgContext,
  parseConversationRouteContext,
  parseStoredConversationRouteContext,
  serializeStoredConversationRouteContext,
} from "./conversation-route-context.js";

describe("conversation route context", () => {
  it("captures configured channel scopes deterministically", () => {
    expect(
      conversationRouteContextFromMsgContext({
        OriginatingChannel: "Discord",
        ConversationRoutePeerId: "channel-a",
        GroupSpace: "guild-a",
        ThreadParentId: "parent-a",
        MemberRoleIds: ["support", "admin", "support"],
      }),
    ).toEqual({
      peerId: "channel-a",
      guildId: "guild-a",
      parentPeerId: "parent-a",
      memberRoleIds: ["admin", "support"],
    });
    expect(
      conversationRouteContextFromMsgContext({
        OriginatingChannel: "mattermost",
        GroupSpace: "team-a",
      }),
    ).toEqual({ teamId: "team-a" });
  });

  it("rejects oversized route facts", () => {
    expect(parseConversationRouteContext({ peerId: "x".repeat(513) })).toBeUndefined();
    expect(parseConversationRouteContext({ guildId: "x".repeat(513) })).toBeUndefined();
    expect(
      parseConversationRouteContext({ guildId: "guild-a", parentPeerId: "x".repeat(513) }),
    ).toBeUndefined();
    expect(
      parseConversationRouteContext({
        memberRoleIds: Array.from({ length: 257 }, (_, i) => `${i}`),
      }),
    ).toBeUndefined();
    expect(
      parseConversationRouteContext({ peerId: "peer-a", memberRoleIds: ["role-a", ""] }),
    ).toBeUndefined();
  });

  it("invalidates an envelope when an older writer advances association activity", () => {
    const stored = serializeStoredConversationRouteContext({ guildId: "guild-a" }, 100);

    expect(parseStoredConversationRouteContext(stored, 100)).toEqual({
      context: { guildId: "guild-a" },
    });
    expect(parseStoredConversationRouteContext(stored, 200)).toBeUndefined();
  });
});
