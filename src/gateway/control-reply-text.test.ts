import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { stripSuppressedControlReplyToken } from "./control-reply-text.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";

describe("control reply display projection", () => {
  it("preserves text whitespace when no control token is present", () => {
    expect(stripSuppressedControlReplyToken("  keep padded  ")).toBe("  keep padded  ");
    expect(
      projectChatDisplayMessages([
        { role: "assistant", content: [{ type: "text", text: "  keep padded  " }] },
      ]),
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: "  keep padded  " }] }]);
  });

  it("preserves control-looking text when it accompanies displayable content", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "NO_REPLY" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ],
    };

    expect(stripSuppressedControlReplyToken("NO_REPLY")).toBe("");
    expect(projectChatDisplayMessages([message])).toEqual([message]);
  });

  it("strips a standalone control token beside visible text", () => {
    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Visible reply" },
            { type: "text", text: "NO_REPLY" },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visible reply" },
          { type: "text", text: "" },
        ],
      },
    ]);
  });

  it("preserves control-looking text forwarded from another session", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:webchat:source",
        sourceTool: "sessions_send",
      },
    };

    expect(projectChatDisplayMessages([message])).toEqual([message]);
  });

  it("strips a trailing sessions control token from substantive text", () => {
    const text = "The handoff is complete.\n\nREPLY_SKIP";

    expect(stripSuppressedControlReplyToken(text)).toBe("The handoff is complete.");
    expect(projectLiveAssistantBufferedText(text)).toEqual({
      text: "The handoff is complete.",
      suppress: false,
      pendingLeadFragment: false,
    });
    expect(
      projectChatDisplayMessages([{ role: "assistant", content: [{ type: "text", text }] }]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "The handoff is complete." }],
      },
    ]);
  });

  it("strips a trailing control token after removing inline directives", () => {
    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The handoff is complete.\n\nREPLY_SKIP [[audio_as_voice]]",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "The handoff is complete." }],
      },
    ]);
  });

  it("hides a control-only reply with an inline directive", () => {
    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY [[audio_as_voice]]" }],
        },
      ]),
    ).toEqual([]);
  });

  it("hides a control-only reply that also contains model thinking", () => {
    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "The loop is complete." },
            { type: "text", text: "REPLY_SKIP" },
          ],
        },
      ]),
    ).toEqual([]);
  });
});
