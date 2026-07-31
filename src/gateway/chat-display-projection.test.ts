import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.js";
import { mirrorMessageToolVisibleReplies } from "./chat-display-projection.message-tool.js";

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
