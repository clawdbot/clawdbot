import { describe, expect, it } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { resolveMSTeamsProactiveReplyStyle } from "./send-context.js";

function channelRef(params?: Partial<StoredConversationReference>): StoredConversationReference {
  return {
    user: { id: "user-1" },
    agent: { id: "agent-1" },
    conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
    channelId: "msteams",
    teamId: "team-1",
    ...params,
  };
}

describe("resolveMSTeamsProactiveReplyStyle", () => {
  it("uses thread for channel conversations with a stored thread root", () => {
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: {},
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ threadId: "thread-root-1" }),
        conversationType: "channel",
      }),
    ).toBe("thread");
  });

  it("falls back to activityId for legacy channel references", () => {
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: {},
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ activityId: "legacy-root-1" }),
        conversationType: "channel",
      }),
    ).toBe("thread");
  });

  it("keeps configured top-level channel routing", () => {
    const cfg: MSTeamsConfig = {
      replyStyle: "thread",
      teams: {
        "team-1": {
          channels: {
            "19:channel@thread.tacv2": { replyStyle: "top-level" },
          },
        },
      },
    };

    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg,
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ threadId: "thread-root-1" }),
        conversationType: "channel",
      }),
    ).toBe("top-level");
  });

  it("uses top-level when a channel has no stored thread root", () => {
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: { replyStyle: "thread" },
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef(),
        conversationType: "channel",
      }),
    ).toBe("top-level");
  });

  it("uses top-level for non-channel conversations", () => {
    const ref = channelRef({ activityId: "activity-1" });

    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: { replyStyle: "thread" },
        conversationId: "19:group@thread.v2",
        ref,
        conversationType: "groupChat",
      }),
    ).toBe("top-level");
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: { replyStyle: "thread" },
        conversationId: "a:personal",
        ref,
        conversationType: "personal",
      }),
    ).toBe("top-level");
  });
});
