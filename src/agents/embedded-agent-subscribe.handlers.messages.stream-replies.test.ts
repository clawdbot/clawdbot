import { describe, expect, it } from "vitest";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  hasAssistantVisibleReply,
  recordPendingAssistantReplyDirectives,
  resolveManagedStreamMediaUrls,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { resolveStreamingReply } from "./embedded-agent-subscribe.handlers.messages.stream.js";

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

describe("assistant stream managed media", () => {
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

describe("resolveStreamingReply", () => {
  it("appends visible text across long blank runs without stalling the media scan", () => {
    const delta = `before${"\n".repeat(60_000)}after`;
    const started = performance.now();
    expect(
      resolveStreamingReply({
        evtType: "text_delta",
        next: delta,
        previousText: "",
        previousCleaned: "",
        visibleDelta: delta,
        appendDelta: delta,
        parsedStreamDirectives: { text: delta, replyToTag: false, isSilent: false },
      }),
    ).toEqual({ text: delta, delta, replace: false, hasText: true });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
