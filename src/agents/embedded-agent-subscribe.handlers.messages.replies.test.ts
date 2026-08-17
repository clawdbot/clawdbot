import { describe, expect, it } from "vitest";
import {
  consumePendingToolMediaIntoReply,
  consumePendingToolMediaReply,
  readPendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";

describe("consumePendingToolMediaIntoReply", () => {
  it("attaches queued tool media to the next assistant reply", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png", "/tmp/a.png", "/tmp/b.png"],
      pendingToolMediaAttachments: [
        { type: "image" as const, path: "/tmp/a.png", width: 640, height: 480 },
        { type: "image" as const, path: "/tmp/a.png", width: 1, height: 1 },
        { type: "image" as const, path: "/tmp/b.png", width: 800, height: 600 },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/a.png", true],
        ["/tmp/b.png", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      attachments: [
        {
          type: "image",
          path: "/tmp/a.png",
          width: 640,
          height: 480,
          trustedLocalMedia: true,
        },
        { type: "image", path: "/tmp/b.png", width: 800, height: 600 },
      ],
      audioAsVoice: undefined,
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolMediaAttachments).toStrictEqual([]);
  });

  it("does not append queued image tool media when the reply already names media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.png"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/generated.png", true]]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["./selected.png"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["./selected.png"],
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
    expect(state.pendingToolMediaTrustByUrl.size).toBe(0);
  });

  it("retains queued metadata for explicitly selected media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.mp3", "/tmp/generated.mp3", "/tmp/unselected.mp3"],
      pendingToolMediaAttachments: [
        { type: "audio" as const, path: "/tmp/generated.mp3", durationMs: 2_000 },
        { type: "audio" as const, path: "/tmp/generated.mp3", durationMs: 9_999 },
        { type: "audio" as const, path: "/tmp/unselected.mp3", durationMs: 3_000 },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/generated.mp3", true],
        ["/tmp/unselected.mp3", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: [" /tmp/generated.mp3 "],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: [" /tmp/generated.mp3 "],
      attachments: [
        {
          type: "audio",
          path: "/tmp/generated.mp3",
          durationMs: 2_000,
          trustedLocalMedia: true,
        },
      ],
      trustedLocalMedia: true,
    });
    expect(state.pendingToolMediaAttachments).toStrictEqual([]);
  });

  it("does not trust an explicitly selected untrusted pending URL", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.mp3", "/tmp/untrusted.mp3"],
      pendingToolMediaAttachments: [
        { type: "audio" as const, path: "/tmp/generated.mp3" },
        {
          type: "audio" as const,
          path: "/tmp/untrusted.mp3",
          trustedLocalMedia: true,
        },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/generated.mp3", true],
        ["/tmp/untrusted.mp3", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["/tmp/untrusted.mp3"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/untrusted.mp3"],
      attachments: [{ type: "audio", path: "/tmp/untrusted.mp3" }],
    });
  });

  it("does not append queued voice media when the reply already names media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", true]]),
      pendingToolAudioAsVoice: true,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["/tmp/assistant-provided.opus"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/assistant-provided.opus"],
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
    expect(state.pendingToolMediaTrustByUrl.size).toBe(0);
  });

  it("preserves reasoning replies without consuming queued media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/a.png", false]]),
      pendingToolAudioAsVoice: true,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "thinking",
        isReasoning: true,
      }),
    ).toEqual({
      text: "thinking",
      isReasoning: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/a.png"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });
});

describe("consumePendingToolMediaReply", () => {
  it("reads a media-only reply without consuming queued tool media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", false]]),
      pendingToolAudioAsVoice: true,
    };

    expect(readPendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });

  it("builds a media-only reply for orphaned tool media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", false]]),
      pendingToolAudioAsVoice: true,
    };

    expect(consumePendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
  });
});
