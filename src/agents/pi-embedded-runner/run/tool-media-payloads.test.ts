import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

describe("mergeAttemptToolMediaPayloads", () => {
  it("attaches tool media to the first visible reply", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [
          { text: "thinking", isReasoning: true },
          { text: "done", mediaUrls: ["/tmp/a.png"] },
        ],
        toolMediaUrls: ["/tmp/a.png", "/tmp/b.opus"],
        toolAudioAsVoice: true,
      }),
    ).toEqual([
      { text: "thinking", isReasoning: true },
      {
        text: "done",
        mediaUrls: ["/tmp/a.png", "/tmp/b.opus"],
        mediaUrl: "/tmp/a.png",
        audioAsVoice: true,
      },
    ]);
  });

  it("creates a media-only reply when no visible reply exists", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "thinking", isReasoning: true }],
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
      }),
    ).toEqual([
      { text: "thinking", isReasoning: true },
      {
        mediaUrls: ["/tmp/reply.opus"],
        mediaUrl: "/tmp/reply.opus",
        audioAsVoice: true,
      },
    ]);
  });

  it("preserves reply metadata when attaching tool media to a visible reply", () => {
    const visibleReply = setReplyPayloadMetadata(
      { text: "done" },
      {
        assistantMessageIndex: 7,
        deliverDespiteSourceReplySuppression: true,
      },
    );

    const [reasoningReply, mergedReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "thinking", isReasoning: true }, visibleReply],
        toolMediaUrls: ["/tmp/reply.png"],
      }) ?? [];

    expect(reasoningReply).toEqual({ text: "thinking", isReasoning: true });
    expect(mergedReply).toEqual({
      text: "done",
      mediaUrls: ["/tmp/reply.png"],
      mediaUrl: "/tmp/reply.png",
    });
    expect(getReplyPayloadMetadata(mergedReply ?? {})).toEqual({
      assistantMessageIndex: 7,
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("preserves trusted local media provenance when merging tool media", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "done" }],
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
        toolTrustedLocalMedia: true,
      }),
    ).toEqual([
      {
        text: "done",
        mediaUrls: ["/tmp/reply.opus"],
        mediaUrl: "/tmp/reply.opus",
        audioAsVoice: true,
        trustedLocalMedia: true,
      },
    ]);
  });

  it("does not attach tool media to message-tool-only source reply mirrors", () => {
    const sourceReply = setReplyPayloadMetadata(
      { text: "sent through message tool" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          text: "sent through message tool",
        },
      },
    );

    const [mergedReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [sourceReply],
        toolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(mergedReply).toEqual({ text: "sent through message tool" });
    expect(getReplyPayloadMetadata(mergedReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        text: "sent through message tool",
      },
    });
  });
});
