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
    expect(projectChatDisplayMessages([message])).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "NO_REPLY" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png" },
            omitted: true,
            bytes: 2,
          },
        ],
      },
    ]);
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

  it("holds a lone uppercase N as a pending NO_REPLY lead fragment (#122476)", () => {
    // A single streamed N is the first delta of NO_REPLY; hold it pending until
    // the next delta disambiguates, so it never flashes on a delta-rendering
    // channel (Matrix, generic streaming) before the full token resolves.
    expect(projectLiveAssistantBufferedText("N")).toEqual({
      text: "N",
      suppress: true,
      pendingLeadFragment: true,
    });
    expect(projectLiveAssistantBufferedText("NO")).toEqual({
      text: "NO",
      suppress: true,
      pendingLeadFragment: true,
    });
  });

  it("holds a mixed-case No lead pending, but not text with spaces (#122476)", () => {
    // A streamed "No" may still grow into NO_REPLY, so it is held pending
    // (matching the embedded TUI backend) rather than flashed; the final
    // payload renders "No" if the turn resolves to natural language. Text
    // containing a space already disambiguates from the token and is not held.
    expect(projectLiveAssistantBufferedText("No")).toEqual({
      text: "No",
      suppress: true,
      pendingLeadFragment: true,
    });
    expect(projectLiveAssistantBufferedText("Not sure")).toEqual({
      text: "Not sure",
      suppress: false,
      pendingLeadFragment: false,
    });
  });
});
