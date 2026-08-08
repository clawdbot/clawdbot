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
import { buildSessionHistorySnapshot } from "./session-history-state.js";

describe("oversized multimodal chat history", () => {
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
    const projected = projectChatDisplayMessages([message]);
    const websocket = replaceOversizedChatHistoryMessages({
      messages: projected,
      maxSingleMessageBytes: CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
    }).messages;
    const sse = buildSessionHistorySnapshot({ rawMessages: [message], limit: 5 }).history.messages;

    for (const messages of [websocket, sse]) {
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
    const projected = projectChatDisplayMessages([message]);
    const websocket = replaceOversizedChatHistoryMessages({
      messages: projected,
      maxSingleMessageBytes: CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
    }).messages;
    const sse = buildSessionHistorySnapshot({ rawMessages: [message], limit: 5 }).history.messages;

    for (const messages of [websocket, sse]) {
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
