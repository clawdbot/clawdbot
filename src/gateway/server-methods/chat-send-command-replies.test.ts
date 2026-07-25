import { describe, expect, it } from "vitest";
import { selectChatSendFinalReplyPayloads } from "./chat-send-command-replies.js";

describe("selectChatSendFinalReplyPayloads", () => {
  it("keeps final replies and suppresses already-persisted media replies", () => {
    const deliveredReplies = [
      { kind: "block" as const, payload: { text: "progress" } },
      { kind: "final" as const, payload: { text: "done" } },
    ];

    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies,
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([{ text: "done" }]);
    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies,
        foldCommandBlocks: true,
        suppressReplies: true,
      }),
    ).toEqual([]);
  });

  it("folds duplicate command media and semantics into the block reply", () => {
    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies: [
          {
            kind: "block",
            payload: {
              text: "done",
              mediaUrl: "file:///tmp/result.png",
              trustedLocalMedia: true,
            },
          },
          {
            kind: "final",
            payload: {
              text: "done",
              mediaUrls: ["/tmp/result.png"],
              sensitiveMedia: true,
              replyToId: "message-1",
            },
          },
        ],
        foldCommandBlocks: true,
        suppressReplies: false,
      }),
    ).toEqual([
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: ["file:///tmp/result.png"],
        trustedLocalMedia: true,
        sensitiveMedia: true,
        replyToId: "message-1",
      },
    ]);
  });

  it("keeps unmatched final text while deduplicating its media", () => {
    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies: [
          {
            kind: "block",
            payload: { text: "progress", mediaUrl: "/tmp/result.png" },
          },
          {
            kind: "final",
            payload: {
              text: "done",
              mediaUrl: "file:///tmp/result.png",
              audioAsVoice: true,
            },
          },
        ],
        foldCommandBlocks: true,
        suppressReplies: false,
      }),
    ).toEqual([
      {
        text: "progress",
        mediaUrl: undefined,
        mediaUrls: ["/tmp/result.png"],
        audioAsVoice: true,
      },
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: undefined,
        audioAsVoice: true,
      },
    ]);
  });
});
