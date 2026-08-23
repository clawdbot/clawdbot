// Tool media payload tests cover how generated media from tools is attached to
// visible embedded-run replies without disturbing source-reply metadata.
import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

describe("mergeAttemptToolMediaPayloads", () => {
  it("attaches tool media to the first visible reply", () => {
    // Reasoning payloads are not user-visible replies, so media attaches to the
    // first final/visible payload instead.
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

  it("marks harness-owned media when source replies require the message tool", () => {
    const [mediaReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(mediaReply).toEqual({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
      audioAsVoice: undefined,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("does not mark generic tool media as host-owned", () => {
    const [mediaReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(mediaReply).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toBeUndefined();
  });

  it("ignores host-owned provenance outside the delivered tool media set", () => {
    const [mediaReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/tool.png"],
        hostOwnedToolMediaUrls: ["/tmp/forged.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(mediaReply).toMatchObject({
      mediaUrls: ["/tmp/tool.png"],
      mediaUrl: "/tmp/tool.png",
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toBeUndefined();
  });

  it("keeps generic and host-owned media in separate delivery payloads", () => {
    const [genericReply, hostOwnedReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/reply.opus", "/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(genericReply).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(genericReply ?? {})).toBeUndefined();
    expect(hostOwnedReply).toEqual({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
      audioAsVoice: undefined,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(hostOwnedReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("does not mark text-bearing source replies as host-owned", () => {
    const [reply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "hidden final" }],
        toolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(reply).toEqual({
      text: "hidden final",
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
    });
    expect(getReplyPayloadMetadata(reply ?? {})).toBeUndefined();
  });

  it("keeps host-owned media deliverable beside suppressed assistant text", () => {
    const [textReply, mediaReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "Done" }],
        toolMediaUrls: ["/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(textReply).toEqual({ text: "Done" });
    expect(getReplyPayloadMetadata(textReply ?? {})).toBeUndefined();
    expect(mediaReply).toEqual({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
      audioAsVoice: undefined,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("merges generic media with assistant text while splitting host-owned media", () => {
    const [textReply, mediaReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "Done" }],
        toolMediaUrls: ["/tmp/reply.opus", "/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(textReply).toEqual({
      text: "Done",
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
    });
    expect(getReplyPayloadMetadata(textReply ?? {})).toBeUndefined();
    expect(mediaReply).toEqual({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
      audioAsVoice: undefined,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
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
    // Source reply mirrors already represent delivered message-tool output;
    // adding separate tool media would duplicate or mutate the transcript mirror.
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
