// Discord tests cover channel.conversation plugin behavior.
import { describe, expect, it } from "vitest";
import {
  matchDiscordAcpConversation,
  resolveDiscordInboundConversation,
} from "./channel.conversation.js";

describe("Discord conversation identity", () => {
  it("uses raw thread ids with parent channel ids for inbound thread conversations", () => {
    expect(
      resolveDiscordInboundConversation({
        from: "discord:user:570610468352294922",
        to: "channel:1510164477642014740",
        conversationId: "channel:1510164477642014740",
        threadId: "1510164477642014740",
        threadParentId: "1510164477642014999",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: "1510164477642014740",
      parentConversationId: "channel:1510164477642014999",
    });
  });

  it("falls back to the current target when inbound thread parent ids are unavailable", () => {
    expect(
      resolveDiscordInboundConversation({
        from: "discord:user:570610468352294922",
        to: "channel:1510164477642014740",
        conversationId: "channel:1510164477642014740",
        threadId: "1510164477642014740",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: "1510164477642014740",
      parentConversationId: "channel:1510164477642014740",
    });
  });

  it("keeps top-level channel conversations prefixed", () => {
    expect(
      resolveDiscordInboundConversation({
        from: "discord:user:570610468352294922",
        to: "channel:1510164477642014740",
        conversationId: "channel:1510164477642014740",
        isGroup: true,
      }),
    ).toEqual({ conversationId: "channel:1510164477642014740" });
  });

  it("matches configured parent channel bindings for inbound thread conversations", () => {
    const resolved = resolveDiscordInboundConversation({
      from: "discord:user:570610468352294922",
      to: "channel:1510164477642014740",
      conversationId: "channel:1510164477642014740",
      threadId: "1510164477642014740",
      threadParentId: "1510164477642014999",
      isGroup: true,
    });

    expect(
      resolved &&
        matchDiscordAcpConversation({
          bindingConversationId: "channel:1510164477642014999",
          conversationId: resolved.conversationId,
          parentConversationId: resolved.parentConversationId,
        }),
    ).toEqual({
      conversationId: "channel:1510164477642014999",
      matchPriority: 1,
    });
  });

  it("prefers exact thread bindings over parent channel fallback", () => {
    expect(
      matchDiscordAcpConversation({
        bindingConversationId: "1510164477642014740",
        conversationId: "1510164477642014740",
        parentConversationId: "channel:1510164477642014999",
      }),
    ).toEqual({
      conversationId: "1510164477642014740",
      matchPriority: 2,
    });
  });
});
