// Copy-text presentation tests cover normalization, legacy bridging, and visible fallback.
import { describe, expect, it } from "vitest";
import {
  normalizeMessagePresentation,
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
} from "./payload.js";

describe("copy-text presentation actions", () => {
  it("preserves exact nonblank copy text through normalization and the legacy bridge", () => {
    const copyText = "\n openclaw status \n";
    const normalized = normalizeMessagePresentation({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Copy command",
              action: { type: "copy-text", text: copyText },
            },
          ],
        },
      ],
    });

    const expected = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Copy command",
              action: { type: "copy-text" as const, text: copyText },
            },
          ],
        },
      ],
    };
    expect(normalized).toEqual(expected);
    expect(presentationToInteractiveReply(normalized!)).toEqual(expected);
  });

  it("rejects empty copy text and preserves whitespace-only copy text", () => {
    expect(
      normalizeMessagePresentation({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Copy", action: { type: "copy-text", text: "" } }],
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      normalizeMessagePresentation({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Copy space", action: { type: "copy-text", text: " " } }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Copy space", action: { type: "copy-text", text: " " } }],
        },
      ],
    });
  });

  it("keeps valid copy text visible in fallback", () => {
    expect(
      renderMessagePresentationFallbackText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy token",
                  action: { type: "copy-text", text: "TOKEN-7319" },
                },
              ],
            },
          ],
        },
      }),
    ).toBe("- Copy token: `TOKEN-7319`");
  });

  it("uses a complete code fence for multiline copy text containing backticks", () => {
    const copyText = "line one\nline `two`";

    expect(
      renderMessagePresentationFallbackText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Copy value", action: { type: "copy-text", text: copyText } }],
            },
          ],
        },
      }),
    ).toBe("- Copy value:\n```\nline one\nline `two`\n```");
  });

  it.each([
    ["a carriage return", "TOKEN\r7319"],
    ["a line separator", "TOKEN\u20287319"],
    ["a paragraph separator", "TOKEN\u20297319"],
    ["a CRLF pair", "TOKEN\r\n7319"],
  ])("fences copy text broken by %s instead of an inline span", (_name, copyText) => {
    expect(
      renderMessagePresentationFallbackText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Copy value", action: { type: "copy-text", text: copyText } }],
            },
          ],
        },
      }),
    ).toBe(`- Copy value:\n\`\`\`\n${copyText}\n\`\`\``);
  });
});
