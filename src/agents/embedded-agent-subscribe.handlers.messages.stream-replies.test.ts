import { describe, expect, it } from "vitest";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  hasAssistantVisibleReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  buildAssistantStreamData,
  recordPendingAssistantReplyDirectives,
} from "./embedded-agent-subscribe.handlers.messages.test-support.js";

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
  it("normalizes media payloads for assistant stream events", () => {
    expect(
      buildAssistantStreamData({
        text: "hello",
        delta: "he",
        replace: true,
        mediaUrl: "https://example.com/a.png",
        phase: "final_answer",
      }),
    ).toEqual({
      text: "hello",
      delta: "he",
      replace: true,
      mediaUrls: ["https://example.com/a.png"],
      phase: "final_answer",
    });
  });
});

describe("pending assistant reply directives", () => {
  it("merges directive metadata into the next non-reasoning block reply", () => {
    const state = { pendingAssistantReplyDirectives: undefined };

    recordPendingAssistantReplyDirectives(state, {
      text: "",
      mediaUrls: ["/tmp/reply.ogg"],
      replyToCurrent: true,
      replyToTag: true,
      audioAsVoice: true,
      isSilent: false,
      mediaTokenSkippedInFence: false,
      fencedSkippedMediaDirectives: [],
    });

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      mediaUrls: ["/tmp/reply.ogg"],
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
        mediaUrls: ["/tmp/reply.png"],
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
    expect(state.pendingAssistantReplyDirectives?.mediaUrls).toEqual(["/tmp/reply.png"]);
  });
});

it("preserves fenced MEDIA directive metadata for embedded block replies (#41966)", () => {
  const state = { pendingAssistantReplyDirectives: undefined };

  recordPendingAssistantReplyDirectives(state, {
    text: "```\nMEDIA:/tmp/demo.png\n```",
    mediaUrls: undefined,
    replyToCurrent: false,
    replyToTag: false,
    audioAsVoice: false,
    isSilent: false,
    mediaTokenSkippedInFence: true,
    fencedSkippedMediaDirectives: ["MEDIA:/tmp/demo.png"],
  });

  expect(state.pendingAssistantReplyDirectives).toEqual({
    mediaUrls: undefined,
    audioAsVoice: undefined,
    replyToId: undefined,
    replyToTag: undefined,
    replyToCurrent: undefined,
    mediaTokenSkippedInFence: true,
    fencedSkippedMediaDirectives: ["MEDIA:/tmp/demo.png"],
  });

  expect(
    consumePendingAssistantReplyDirectivesIntoReply(state, {
      text: "```\nMEDIA:/tmp/demo.png\n```",
    }),
  ).toEqual({
    text: "```\nMEDIA:/tmp/demo.png\n```",
    mediaUrls: undefined,
    audioAsVoice: undefined,
    replyToId: undefined,
    replyToTag: undefined,
    replyToCurrent: undefined,
    mediaTokenSkippedInFence: true,
    fencedSkippedMediaDirectives: ["MEDIA:/tmp/demo.png"],
  });
  expect(state.pendingAssistantReplyDirectives).toBeUndefined();
});
