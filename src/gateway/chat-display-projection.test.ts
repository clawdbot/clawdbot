import { describe, expect, it } from "vitest";
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
