import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { getMediaDir } from "../media/store.js";
import {
  projectChatDisplayMessages,
  sanitizeChatHistoryMessages,
} from "./chat-display-projection.js";
import { mirrorMessageToolVisibleReplies } from "./chat-display-projection.message-tool.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
} from "./server-methods/chat-history-budget.js";
import { buildSessionHistorySnapshot, SessionHistorySseState } from "./session-history-state.js";

function projectHistoryTransports(message: Record<string, unknown>) {
  const websocket = replaceOversizedChatHistoryMessages({
    messages: projectChatDisplayMessages([message]),
    maxSingleMessageBytes: CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  }).messages;
  const sse = buildSessionHistorySnapshot({ rawMessages: [message], limit: 5 }).history.messages;
  return [websocket, sse];
}

describe("managed document chat history", () => {
  it("keeps the attachment envelope while stripping URL capabilities", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "attachment",
          attachment: {
            artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
            kind: "document",
            label: "report.csv",
            mimeType: "text/csv",
            sizeBytes: 12,
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full?mediaTicket=secret",
          },
        },
      ],
    };

    expect(sanitizeChatHistoryMessages([message])).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
              kind: "document",
              label: "report.csv",
              mimeType: "text/csv",
              sizeBytes: 12,
              url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
            },
          },
        ],
      },
    ]);
  });

  it("sanitizes attachment capabilities after another field already changed", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "attachment",
          thinkingSignature: "private-reasoning-signature",
          attachment: {
            kind: "document",
            label: "report.csv",
            path: "/tmp/private-report.csv",
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full?mediaTicket=secret",
          },
        },
      ],
    };

    expect(sanitizeChatHistoryMessages([message])).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "report.csv",
              url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full",
            },
          },
        ],
      },
    ]);
  });
});

describe("oversized multimodal chat history", () => {
  it("keeps legacy image, audio, and video transcript blocks through every history boundary", async () => {
    const inlineImage = Buffer.from("inline image").toString("base64");
    const inlineAudio = Buffer.from("inline audio").toString("base64");
    const inlineVideo = Buffer.from("inline video").toString("base64");
    const rawMessage = {
      role: "user",
      content: [
        { type: "text", text: "keep mixed media metadata" },
        {
          type: "image",
          mimeType: "image/png",
          data: inlineImage,
          path: "/tmp/private-image.png",
          url: "https://image-user@media.example/image.png?signature=image-secret#image-fragment",
          source: {
            type: "base64",
            data: inlineImage,
            blob: inlineImage,
            url: "media://inbound/image-claim",
          },
        },
        {
          type: "audio",
          mimeType: "audio/wav",
          blob: inlineAudio,
          filePath: String.raw`C:\private-audio.wav`,
          audio_url: "media://inbound/audio-claim",
          source: {
            type: "url",
            data: inlineAudio,
            url: "https://audio-user@media.example/audio.wav?token=audio-secret#audio-fragment",
          },
        },
        {
          type: "video",
          mimeType: "video/mp4",
          data: inlineVideo,
          localPath: String.raw`\\server\share\private-video.mp4`,
          video_url:
            "https://video-user@media.example/video.mp4?X-Amz-Signature=video-secret#video-fragment",
          source: {
            type: "url",
            blob: inlineVideo,
            url: "media://inbound/video-claim",
          },
        },
      ],
    };
    const expected = projectChatDisplayMessages([rawMessage]);
    const snapshot = buildSessionHistorySnapshot({ rawMessages: [rawMessage] }).history.messages;
    const sseState = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "mixed-media", sessionKey: "agent:main:mixed-media" },
      rawMessages: [],
    });
    const incremental = sseState.appendInlineMessage({ message: rawMessage })?.message;
    const projections = [
      ["projectChatDisplayMessages", expected],
      ["session-history snapshot", snapshot],
      ["incremental SSE state", incremental ? [incremental] : []],
    ] as const;
    for (const [boundary, messages] of projections) {
      expect(messages, boundary).toHaveLength(1);
      expect(messages[0], boundary).toMatchObject({
        role: "user",
        content: expected[0]?.content,
      });
      expect((messages[0] as { content?: unknown[] }).content).toEqual([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
        expect.objectContaining({ type: "audio", mimeType: "audio/wav" }),
        expect.objectContaining({ type: "video", mimeType: "video/mp4" }),
      ]);
      const serialized = JSON.stringify(messages);
      for (const secret of [
        inlineImage,
        inlineAudio,
        inlineVideo,
        "private-image",
        "private-audio",
        "private-video",
        "image-user",
        "audio-user",
        "video-user",
        "image-secret",
        "audio-secret",
        "video-secret",
        "image-fragment",
        "audio-fragment",
        "video-fragment",
      ]) {
        expect(serialized, `${boundary}: ${secret}`).not.toContain(secret);
      }
      expect(serialized, boundary).toContain("media://inbound/image-claim");
      expect(serialized, boundary).toContain("media://inbound/audio-claim");
      expect(serialized, boundary).toContain("media://inbound/video-claim");
      expect(serialized, boundary).toContain("https://media.example/image.png");
      expect(serialized, boundary).toContain("https://media.example/audio.wav");
      expect(serialized, boundary).toContain("https://media.example/video.mp4");
    }
  });

  it("projects media even when another block field is sanitized first", () => {
    const payload = Buffer.from("short-circuit video payload");
    const encoded = payload.toString("base64");
    const message = {
      role: "user",
      content: [
        {
          type: "video",
          mimeType: "video/mp4",
          data: encoded,
          blob: encoded,
          path: "/private/short-circuit-video.mp4",
          url: "https://media-user@media.example/video.mp4?signature=private-signature#private-fragment",
          openclawReasoningReplay: { private: true },
        },
      ],
    };

    const messages = sanitizeChatHistoryMessages([message]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "video",
            mimeType: "video/mp4",
            url: "https://media.example/video.mp4",
            omitted: true,
            bytes: payload.length,
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(messages);
    for (const privateValue of [
      encoded,
      "/private/short-circuit-video.mp4",
      "media-user",
      "private-signature",
      "private-fragment",
      "openclawReasoningReplay",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([
    {
      name: "native image data",
      image: (data: string) => ({ type: "image", mimeType: "image/png", data }),
    },
    {
      name: "Anthropic image source",
      image: (data: string) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      }),
    },
  ])("keeps text while omitting $name from WebSocket and SSE history", ({ image }) => {
    const png = createNoisyPngBuffer(320, 320);
    const encoded = png.toString("base64");
    const message = {
      role: "user",
      content: [
        { type: "text", text: "keep prefix text" },
        image(encoded),
        { type: "text", text: "keep suffix text" },
      ],
    };
    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toMatchObject([
        {
          role: "user",
          content: [
            { type: "text", text: "keep prefix text" },
            { type: "image", omitted: true, bytes: png.length },
            { type: "text", text: "keep suffix text" },
          ],
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain(encoded);
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(
        CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
      );
    }
  });

  it("preserves URL-backed images without changing their sources", () => {
    const source = { type: "url", url: "https://example.invalid/picture.png" };
    expect(
      projectChatDisplayMessages([{ role: "user", content: [{ type: "image", source }] }]),
    ).toEqual([{ role: "user", content: [{ type: "image", source }] }]);
  });

  it("omits persisted top-level audio data from WebSocket and SSE history", () => {
    const audio = Buffer.from("persisted audio bytes");
    const encoded = audio.toString("base64");
    const message = {
      role: "user",
      content: [
        { type: "text", text: "keep prefix text" },
        { type: "audio", mimeType: "audio/wav", data: encoded },
        { type: "text", text: "keep suffix text" },
      ],
    };

    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "keep prefix text" },
            { type: "audio", mimeType: "audio/wav", omitted: true, bytes: audio.length },
            { type: "text", text: "keep suffix text" },
          ],
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain(encoded);
    }
  });

  it("removes private audio payloads and local references while preserving safe refs", () => {
    const privateMarker = "private-audio-reference";
    const safeAudio = [
      {
        type: "audio",
        url: "https://example.invalid/audio.wav",
        openUrl: "http://example.invalid/audio.wav",
        audio_url: "media://inbound/audio.wav",
        source: { type: "url", url: "/api/chat/media/outgoing/audio.wav" },
      },
      { type: "audio", url: "/media/audio.wav", openUrl: "/__openclaw__/audio/clip.wav" },
    ];
    const message = {
      role: "user",
      content: [
        {
          type: "audio",
          data: { rawSecret: privateMarker },
          url: `data:audio/wav;base64,${privateMarker}`,
          openUrl: `file:///tmp/${privateMarker}.wav`,
          audio_url: `~/${privateMarker}.wav`,
          path: `/tmp/${privateMarker}.wav`,
          file: privateMarker,
          filePath: String.raw`C:\private-audio-reference.wav`,
          localPath: String.raw`\\server\share\private-audio-reference.wav`,
          source: {
            type: "opaque",
            codec: "pcm",
            data: new Uint8Array([111, 112, 113]),
            url: `/tmp/${privateMarker}-source.wav`,
            path: `/tmp/${privateMarker}-source.wav`,
            file: privateMarker,
            filePath: String.raw`D:\private-audio-reference.wav`,
            localPath: String.raw`\\server\share\private-audio-reference-source.wav`,
          },
        },
        { type: "audio", url: String.raw`C:\a.wav`, source: { url: String.raw`\\s\a.wav` } },
        ...safeAudio,
      ],
    };
    const original = structuredClone(message);

    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "audio",
              omitted: true,
              source: { type: "opaque", codec: "pcm", omitted: true },
            },
            { type: "audio", omitted: true, source: { omitted: true } },
            ...safeAudio,
          ],
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain(privateMarker);
      expect(JSON.stringify(messages)).not.toContain('"0":111');
    }
    expect(message).toEqual(original);
  });

  it("sanitizes newly appended audio before returning an incremental SSE message", () => {
    const encoded = Buffer.from("incremental SSE audio").toString("base64");
    const state = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "audio-session", sessionKey: "agent:main:audio-session" },
      rawMessages: [],
    });

    const appended = state.appendInlineMessage({
      message: {
        role: "user",
        content: [
          { type: "text", text: "keep incremental text" },
          { type: "audio", mimeType: "audio/ogg", data: encoded },
        ],
      },
      messageId: "audio-message",
    });

    expect(appended?.message).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "keep incremental text" },
        {
          type: "audio",
          mimeType: "audio/ogg",
          omitted: true,
          bytes: Buffer.from("incremental SSE audio").length,
        },
      ],
    });
    expect(JSON.stringify(appended?.message)).not.toContain(encoded);
  });
});

describe("transcript metadata projection", () => {
  it("keeps display metadata while omitting oversized upstream prompt metadata", () => {
    const message = {
      role: "user",
      content: "Keep this visible user message.",
      __openclaw: {
        id: "message-1",
        mirrorIdentity: "turn-1:prompt",
        replyToId: "message-0",
        upstreamUserText: "private decorated prompt ".repeat(12_000),
      },
    };
    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toEqual([
        {
          role: "user",
          content: "Keep this visible user message.",
          __openclaw: {
            id: "message-1",
            mirrorIdentity: "turn-1:prompt",
            replyToId: "message-0",
          },
        },
      ]);
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(
        CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
      );
    }
  });

  it("records a display-cap marker on every history transport when text is truncated", () => {
    const message = { role: "assistant", content: "x".repeat(9_000), timestamp: 1 };
    for (const messages of projectHistoryTransports(message)) {
      const projected = messages[0] as Record<string, unknown>;
      expect(JSON.stringify(projected.content)).toContain("...(truncated)...");
      // Structured fact, so consumers fetch the full row via chat.message.get
      // instead of sniffing the in-band sentinel.
      expect(projected["__openclaw"]).toEqual({ truncated: true, reason: "display-cap" });
    }
  });

  it("marks display-cap truncation inside content blocks and keeps existing metadata", () => {
    const [projected] = sanitizeChatHistoryMessages(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "block text ".repeat(20) }],
          __openclaw: { id: "message-9", senderId: "assistant-1" },
        },
      ],
      16,
    ) as Record<string, unknown>[];
    expect(projected?.["__openclaw"]).toEqual({
      id: "message-9",
      senderId: "assistant-1",
      truncated: true,
      reason: "display-cap",
    });
  });

  it("leaves untruncated messages without a truncation marker", () => {
    const [projected] = sanitizeChatHistoryMessages(
      [{ role: "assistant", content: "short", timestamp: 1 }],
      16,
    ) as Record<string, unknown>[];
    expect(projected?.["__openclaw"]).toBeUndefined();
  });

  it("marks display-cap truncation of a tool-result diff on both tool-result shapes", () => {
    const longDiff = "+line\n".repeat(40);
    const [blockShaped, messageShaped] = sanitizeChatHistoryMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "toolResult", toolName: "edit", details: { changed: true, diff: longDiff } },
          ],
        },
        { role: "toolResult", toolName: "edit", details: { changed: true, diff: longDiff } },
      ],
      32,
    ) as Record<string, unknown>[];
    for (const projected of [blockShaped, messageShaped]) {
      expect(JSON.stringify(projected)).toContain("...(truncated)...");
      expect(projected?.["__openclaw"]).toMatchObject({ truncated: true, reason: "display-cap" });
    }
  });

  it("leaves a tool-result diff within the cap unmarked", () => {
    const [projected] = sanitizeChatHistoryMessages(
      [{ role: "toolResult", toolName: "edit", details: { changed: true, diff: "+ok" } }],
      32,
    ) as Record<string, unknown>[];
    expect(projected?.["__openclaw"]).toBeUndefined();
  });

  it("does not overwrite an upstream oversized reason with display-cap", () => {
    const [projected] = sanitizeChatHistoryMessages(
      [
        {
          role: "assistant",
          content: "still long enough to cap ".repeat(4),
          __openclaw: { truncated: true, reason: "oversized" },
        },
      ],
      16,
    ) as Record<string, unknown>[];
    expect(projected?.["__openclaw"]).toEqual({ truncated: true, reason: "oversized" });
  });
});

describe("managed inbound media fact projection", () => {
  const inboundMediaId = "photo---11111111-2222-3333-4444-555555555555.png";
  const managedInboundPath = path.join(getMediaDir(), "inbound", inboundMediaId);

  function projectedOpenClawMeta(message: Record<string, unknown>) {
    const projected = sanitizeChatHistoryMessages([message]);
    return (projected[0] as Record<string, unknown> | undefined)?.["__openclaw"];
  }

  it("rewrites a configured-store managed inbound path to a canonical media URI", () => {
    const message = {
      role: "user",
      content: "first message with an image",
      __openclaw: {
        media: [{ path: managedInboundPath, contentType: "image/png" }],
      },
    };
    expect(projectedOpenClawMeta(message)).toEqual({
      media: [
        {
          path: `media://inbound/${inboundMediaId}`,
          contentType: "image/png",
        },
      ],
    });
  });

  it("redacts a lookalike path that contains media/inbound but is outside the store", () => {
    // A path like /tmp/media/inbound/<existing-id> is NOT inside the configured store;
    // it must not be promoted to an authenticated media capability.
    const lookalike = path.join("/tmp", "media", "inbound", inboundMediaId);
    const message = {
      role: "user",
      content: "lookalike inbound path",
      __openclaw: {
        media: [{ path: lookalike, contentType: "image/png" }],
      },
    };
    expect(projectedOpenClawMeta(message)).toEqual({
      media: [{ contentType: "image/png" }],
    });
  });

  it("redacts host paths that are not inside the managed inbound store", () => {
    const message = {
      role: "user",
      content: "private local image",
      __openclaw: {
        media: [
          { path: "/tmp/private-image.png", contentType: "image/png" },
          {
            path: path.join(getMediaDir(), "outbound", "credentials.png"),
            contentType: "image/png",
          },
        ],
      },
    };
    expect(projectedOpenClawMeta(message)).toEqual({
      media: [{ contentType: "image/png" }, { contentType: "image/png" }],
    });
  });

  it("rejects traversal-shaped inbound paths and redacts them", () => {
    const message = {
      role: "user",
      content: "traversal attempt",
      __openclaw: {
        media: [
          {
            path: path.join(getMediaDir(), "inbound", "..", "..", "etc", "passwd"),
            contentType: "image/png",
          },
        ],
      },
    };
    expect(projectedOpenClawMeta(message)).toEqual({
      media: [{ contentType: "image/png" }],
    });
  });

  it("redacts malformed percent-encoded inbound ids instead of throwing", () => {
    // A stray `%` makes decodeURIComponent throw inside parseInboundMediaUri;
    // the sanitizer must redact rather than propagate the failure into history projection.
    const message = {
      role: "user",
      content: "malformed percent escape",
      __openclaw: {
        media: [{ path: path.join(getMediaDir(), "inbound", "%"), contentType: "image/png" }],
      },
    };
    expect(() => sanitizeChatHistoryMessages([message])).not.toThrow();
    expect(projectedOpenClawMeta(message)).toEqual({
      media: [{ contentType: "image/png" }],
    });
  });

  it("preserves an already-canonical media inbound URI without regression", () => {
    const message = {
      role: "user",
      content: "canonical inbound image",
      __openclaw: {
        media: [
          {
            path: `media://inbound/${inboundMediaId}`,
            contentType: "image/png",
          },
        ],
      },
    };
    expect(projectedOpenClawMeta(message)).toEqual({
      media: [
        {
          path: `media://inbound/${inboundMediaId}`,
          contentType: "image/png",
        },
      ],
    });
  });
});

describe("current user profile display projection", () => {
  it("sender provenance gates profile lookups and alias projection", () => {
    const identity = { type: "profile", id: "shared-id" };
    const rows = [
      identity,
      {
        type: "observation",
        id: "shared-id",
        pluginId: "channel",
        accountId: null,
        senderKind: "unknown",
      },
      undefined,
    ].map((senderIdentity, index) => ({
      role: "user",
      content: `row ${index}`,
      timestamp: index + 1,
      __openclaw: {
        senderId: "shared-id",
        senderName: "Same label",
        ...(senderIdentity ? { senderIdentity } : {}),
      },
    }));
    const original = JSON.stringify(rows);
    const resolveCurrentUserProfileDisplay = vi.fn(() => ({
      kind: "resolved" as const,
      profileId: "canonical-id",
      avatarUrl: "/api/users/canonical-id/avatar?v=2",
      hasUploadedAvatar: true,
    }));
    const projected = projectChatDisplayMessages(rows, { resolveCurrentUserProfileDisplay });
    expect(resolveCurrentUserProfileDisplay).toHaveBeenCalledTimes(1);
    expect(projected[0]?.["__openclaw"]).toMatchObject({
      senderIdentity: { type: "profile", id: "canonical-id" },
      senderProfileAvatarUrl: "/api/users/canonical-id/avatar?v=2",
    });
    expect(projected.slice(1)).toEqual(rows.slice(1));
    expect(JSON.stringify(rows)).toBe(original);
  });

  it("dedupes sender lookups per batch and enriches only resolved sender ids", () => {
    const messages = [
      {
        role: "user",
        content: "first",
        __openclaw: {
          senderIdentity: { type: "profile", id: "profile-ada" },
          senderId: "profile-ada",
          senderName: "Historical Ada",
          senderUsername: "ada",
        },
      },
      {
        role: "user",
        content: "second",
        __openclaw: {
          senderIdentity: { type: "profile", id: "profile-ada" },
          senderId: "profile-ada",
          senderName: "Earlier Ada",
        },
      },
      {
        role: "user",
        content: "third",
        __openclaw: {
          senderIdentity: { type: "profile", id: "profile-bob" },
          senderId: "profile-bob",
        },
      },
      {
        role: "user",
        content: "unknown",
        __openclaw: {
          senderId: "channel-sender",
          senderProfileAvatarUrl: "/channel/avatar",
        },
      },
      { role: "user", content: "missing sender" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hostile assistant metadata" }],
        __openclaw: { senderId: "hostile-assistant" },
      },
      {
        role: "toolResult",
        toolCallId: "hostile-tool-call",
        toolName: "read",
        content: [{ type: "text", text: "hostile tool metadata" }],
        __openclaw: { senderId: "hostile-tool" },
      },
    ];
    const originalMessages = structuredClone(messages);
    const resolveCurrentUserProfileDisplay = vi.fn((senderId: string) => {
      if (senderId === "profile-ada") {
        return {
          kind: "resolved" as const,
          profileId: "profile-ada",
          label: "Current Ada",
          avatarUrl: "/api/users/profile-ada/avatar?v=20",
          hasUploadedAvatar: true,
        };
      }
      if (senderId === "profile-bob") {
        return {
          kind: "resolved" as const,
          profileId: "profile-bob",
          avatarUrl: "/api/users/profile-bob/avatar?v=30",
          hasUploadedAvatar: false,
        };
      }
      return { kind: "unresolved" as const };
    });

    const projected = projectChatDisplayMessages(messages, {
      resolveCurrentUserProfileDisplay,
    });

    expect(resolveCurrentUserProfileDisplay.mock.calls.map(([senderId]) => senderId)).toEqual([
      "profile-ada",
      "profile-bob",
    ]);
    expect(projected.map((message) => message["__openclaw"])).toEqual([
      {
        senderIdentity: { type: "profile", id: "profile-ada" },
        senderId: "profile-ada",
        senderName: "Historical Ada",
        senderUsername: "ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=20",
      },
      {
        senderIdentity: { type: "profile", id: "profile-ada" },
        senderId: "profile-ada",
        senderName: "Earlier Ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=20",
      },
      {
        senderIdentity: { type: "profile", id: "profile-bob" },
        senderId: "profile-bob",
        senderProfileAvatarUrl: "/api/users/profile-bob/avatar?v=30",
      },
      {
        senderId: "channel-sender",
        senderProfileAvatarUrl: "/channel/avatar",
      },
      undefined,
      { senderId: "hostile-assistant" },
      { senderId: "hostile-tool" },
    ]);
    expect(messages).toEqual(originalMessages);
    expect(projected[0]).not.toBe(messages[0]);
    expect(projected[3]).toBe(messages[3]);
    expect(projected[4]).toBe(messages[4]);
    expect(projected[5]).toBe(messages[5]);
  });

  it("overwrites stale and no-upload profile routes while preserving lookup failures", () => {
    const staleAvatar = {
      role: "user",
      content: "stale avatar",
      __openclaw: {
        senderIdentity: { type: "profile", id: "with-avatar" },
        senderId: "with-avatar",
        senderName: "Historical Name",
        senderProfileAvatarUrl: "/api/users/with-avatar/avatar?v=10",
      },
    };
    const noUploadAvatar = {
      role: "user",
      content: "removed avatar",
      __openclaw: {
        senderIdentity: { type: "profile", id: "without-avatar" },
        senderId: "without-avatar",
        senderProfileAvatarUrl: "/api/users/without-avatar/avatar?v=10",
      },
    };
    const failedLookup = {
      role: "user",
      content: "lookup failed",
      __openclaw: {
        senderIdentity: { type: "profile", id: "lookup-failed" },
        senderId: "lookup-failed",
        senderProfileAvatarUrl: "/existing/projected/avatar",
      },
    };
    const projected = projectChatDisplayMessages([staleAvatar, noUploadAvatar, failedLookup], {
      resolveCurrentUserProfileDisplay: (senderId) => {
        if (senderId === "with-avatar") {
          return {
            kind: "resolved",
            profileId: "with-avatar",
            label: "Current Name",
            avatarUrl: "/api/users/with-avatar/avatar?v=20",
            hasUploadedAvatar: true,
          };
        }
        if (senderId === "without-avatar") {
          return {
            kind: "resolved",
            profileId: "without-avatar",
            avatarUrl: "/api/users/without-avatar/avatar?v=20",
            hasUploadedAvatar: false,
          };
        }
        return { kind: "unresolved" };
      },
    });

    expect(projected[0]?.["__openclaw"]).toEqual({
      senderIdentity: { type: "profile", id: "with-avatar" },
      senderId: "with-avatar",
      senderName: "Historical Name",
      senderProfileAvatarUrl: "/api/users/with-avatar/avatar?v=20",
    });
    expect(projected[1]?.["__openclaw"]).toEqual({
      senderIdentity: { type: "profile", id: "without-avatar" },
      senderId: "without-avatar",
      senderProfileAvatarUrl: "/api/users/without-avatar/avatar?v=20",
    });
    expect(projected[2]).toBe(failedLookup);
  });

  it("keeps exact current behavior when no resolver is supplied", () => {
    const message = {
      role: "user",
      content: "unchanged",
      __openclaw: {
        senderIdentity: { type: "profile", id: "profile-ada" },
        senderId: "profile-ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=old",
      },
    };
    const projected = projectChatDisplayMessages([message]);
    expect(projected[0]).toBe(message);
  });
});

describe("chat display message-tool projection", () => {
  it("mirrors an automatic-mode send confirmed for the current source", () => {
    const sourceReply = "Visible reply delivered to Slack.";
    const projected = mirrorMessageToolVisibleReplies([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-message-current-source",
            name: "message",
            arguments: {
              action: "send",
              channel: "slack",
              target: "channel:C123",
              message: sourceReply,
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-current-source",
        content: { ok: true, messageId: "slack-242" },
        details: {
          ok: true,
          messageId: "slack-242",
          sourceReplyRoute: "current-source",
        },
      },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    ]);

    expect(projected).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: sourceReply }],
        openclawMessageToolMirror: expect.objectContaining({
          toolCallId: "call-message-current-source",
        }),
      }),
    );
  });
});

describe("TTS supplement matching", () => {
  it("matches later audio against the text left by an earlier supplement", () => {
    const marker = { textSha256: createHash("sha256").update("same").digest("hex") };
    const firstAudio = { type: "audio", url: "https://example.test/first.mp3" };
    const secondAudio = { type: "audio", url: "https://example.test/second.mp3" };
    const caption = { type: "input_text", text: "caption" };
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 2 },
      {
        role: "assistant",
        content: [caption, firstAudio],
        openclawTtsSupplement: marker,
      },
      { role: "assistant", content: [secondAudio], openclawTtsSupplement: marker },
    ];
    const original = structuredClone(messages);

    expect(projectChatDisplayMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "same" }, secondAudio],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "same" }, caption, firstAudio],
        timestamp: 2,
      },
    ]);
    expect(messages).toEqual(original);
  });
});
