import { describe, expect, it } from "vitest";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  hasAssistantVisibleReply,
  recordPendingAssistantReplyDirectives,
  resolveManagedStreamMediaUrls,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { buildAssistantStreamData } from "./embedded-agent-subscribe.handlers.messages.stream.js";

describe("hasAssistantVisibleReply", () => {
  it("treats audio-only payloads as visible", () => {
    expect(hasAssistantVisibleReply({ audioAsVoice: true })).toBe(true);
  });

  it("detects text or media visibility", () => {
    expect(hasAssistantVisibleReply({ text: "hello" })).toBe(true);
    expect(hasAssistantVisibleReply({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasAssistantVisibleReply({})).toBe(false);
  });
});

describe("buildAssistantStreamData", () => {
  it.each([true, false, undefined])("normalizes media and replacement flag %s", (replace) => {
    expect(
      buildAssistantStreamData({
        text: "hello",
        delta: "he",
        replace,
        mediaUrl: "https://example.com/a.png",
        managedMediaUrls: ["https://example.com/a.png"],
        phase: "final_answer",
      }),
    ).toEqual({
      text: "hello",
      delta: "he",
      replace: replace || undefined,
      mediaUrls: ["https://example.com/a.png"],
      managedMediaUrls: ["https://example.com/a.png"],
      phase: "final_answer",
    });
  });

  it("keeps generic directive URLs separate from tool-owned managed media", () => {
    const state = {
      pendingToolMediaTrustByUrl: new Map([
        ["./managed.png", true],
        ["./ordinary.png", false],
      ]),
    };

    expect(
      resolveManagedStreamMediaUrls(state, ["./ordinary.png", "./managed.png", "./unknown.png"]),
    ).toEqual(["./managed.png"]);
  });
});

describe("pending assistant reply directives", () => {
  it("merges directive metadata into the next non-reasoning block reply", () => {
    const state = { pendingAssistantReplyDirectives: undefined };

    recordPendingAssistantReplyDirectives(state, {
      text: "",
      replyToCurrent: true,
      replyToTag: true,
      audioAsVoice: true,
      isSilent: false,
    });

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
    expect(state.pendingAssistantReplyDirectives).toBeUndefined();
  });

  it("does not consume pending directive metadata on reasoning replies", () => {
    const state = {
      pendingAssistantReplyDirectives: {
        replyToId: "parent-message",
      },
    };

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Thinking...",
        isReasoning: true,
      }),
    ).toEqual({
      text: "Thinking...",
      isReasoning: true,
    });
    expect(state.pendingAssistantReplyDirectives?.replyToId).toBe("parent-message");
  });
});
