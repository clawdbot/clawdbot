import { describe, expect, it } from "vitest";
import { extractTextFromChatContent } from "./chat-content.js";

describe("shared/chat-content", () => {
  it("normalizes plain string content", () => {
    expect(extractTextFromChatContent("  hello\nworld  ")).toBe("hello world");
  });

  it("extracts only text blocks from array content", () => {
    expect(
      extractTextFromChatContent([
        { type: "text", text: " hello " },
        { type: "image_url", image_url: "https://example.com" },
        { type: "text", text: "world" },
        { text: "ignored without type" },
        null,
      ]),
    ).toBe("hello world");
  });

  it("applies sanitizers and custom join/normalization hooks", () => {
    expect(
      extractTextFromChatContent("Here [Tool Call: foo (ID: 1)] ok", {
        sanitizeText: (text) => text.replace(/\[Tool Call:[^\]]+\]\s*/g, ""),
      }),
    ).toBe("Here ok");

    expect(
      extractTextFromChatContent(
        [
          { type: "text", text: " hello " },
          { type: "text", text: "world " },
        ],
        {
          sanitizeText: (text) => text.trim(),
          joinWith: "\n",
          normalizeText: (text) => text.trim(),
        },
      ),
    ).toBe("hello\nworld");

    expect(
      extractTextFromChatContent(
        [
          { type: "text", text: "keep" },
          { type: "text", text: "drop" },
        ],
        {
          sanitizeText: (text) => (text === "drop" ? "   " : text),
        },
      ),
    ).toBe("keep");
  });

  it("returns null for unsupported or empty content", () => {
    expect(extractTextFromChatContent(123)).toBeNull();
    expect(extractTextFromChatContent([{ type: "text", text: "   " }])).toBeNull();
    expect(
      extractTextFromChatContent("  ", {
        sanitizeText: () => "",
      }),
    ).toBeNull();
  });
});
