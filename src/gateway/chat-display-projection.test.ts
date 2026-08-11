import { describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
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

describe("oversized multimodal chat history", () => {
  it("projects one mixed-media message through every history boundary", async () => {
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

describe("private transcript metadata projection", () => {
  it("keeps visible text while omitting oversized upstream prompt metadata", () => {
    const message = {
      role: "user",
      content: "Keep this visible user message.",
      __openclaw: {
        id: "message-1",
        mirrorIdentity: "turn-1:prompt",
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
          },
        },
      ]);
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(
        CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
      );
    }
  });
});

describe("current user profile display projection", () => {
  it("dedupes sender lookups per batch and enriches only resolved sender ids", () => {
    const messages = [
      {
        role: "user",
        content: "first",
        __openclaw: {
          senderId: "profile-ada",
          senderName: "Historical Ada",
          senderUsername: "ada",
        },
      },
      {
        role: "user",
        content: "second",
        __openclaw: { senderId: "profile-ada", senderName: "Earlier Ada" },
      },
      {
        role: "user",
        content: "third",
        __openclaw: { senderId: "profile-bob" },
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
      "channel-sender",
    ]);
    expect(projected.map((message) => message["__openclaw"])).toEqual([
      {
        senderId: "profile-ada",
        senderName: "Historical Ada",
        senderUsername: "ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=20",
      },
      {
        senderId: "profile-ada",
        senderName: "Earlier Ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=20",
      },
      {
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
        senderId: "with-avatar",
        senderName: "Historical Name",
        senderProfileAvatarUrl: "/api/users/with-avatar/avatar?v=10",
      },
    };
    const noUploadAvatar = {
      role: "user",
      content: "removed avatar",
      __openclaw: {
        senderId: "without-avatar",
        senderProfileAvatarUrl: "/api/users/without-avatar/avatar?v=10",
      },
    };
    const failedLookup = {
      role: "user",
      content: "lookup failed",
      __openclaw: {
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
      senderId: "with-avatar",
      senderName: "Historical Name",
      senderProfileAvatarUrl: "/api/users/with-avatar/avatar?v=20",
    });
    expect(projected[1]?.["__openclaw"]).toEqual({
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

describe("chat display tool-result detail projection", () => {
  it("omits opaque provider replay state from display history", () => {
    const [message] = sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }],
        providerReplay: {
          type: "openai-responses-compaction",
          data: "opaque-display-compaction",
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    });
    expect(message).not.toHaveProperty("providerReplay");
    expect(JSON.stringify(message)).not.toContain("opaque-display-compaction");
  });

  it("keeps authoritative write booleans and strips unrelated details", () => {
    const [overwrite, created, invalid] = sanitizeChatHistoryMessages([
      {
        role: "toolResult",
        toolCallId: "write-1",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: false, diff: "-1 old\n+1 new", private: "drop" },
      },
      {
        role: "toolResult",
        toolCallId: "write-2",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: true },
      },
      {
        role: "toolResult",
        toolCallId: "write-3",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: "true", created: 1 },
      },
    ]) as Array<Record<string, unknown>>;

    expect(overwrite?.details).toEqual({
      changed: true,
      created: false,
      diff: "-1 old\n+1 new",
    });
    expect(created?.details).toEqual({ changed: true, created: true });
    expect(invalid).not.toHaveProperty("details");
  });
});
