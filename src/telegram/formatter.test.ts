/**
 * Unit tests for Telegram message formatter
 * Tests core Markdown escaping and emoji filtering behavior
 */
import { describe, it, expect } from "vitest";
import { formatTelegramMessage, formatPlainText } from "./formatter";

describe("formatPlainText", () => {
  it("should escape MarkdownV2 special characters", () => {
    const input = "*bold* _italic_ `code`";
    const result = formatPlainText(input);
    expect(result).toBe("\\*bold\\* \\_italic\\_ \\`code\\`");
  });

  it("should escape parentheses and brackets", () => {
    const input = "[link](url)";
    const result = formatPlainText(input);
    expect(result).toBe("\\[link\\]\\(url\\)");
  });

  it("should preserve allowed status emojis", () => {
    const input = "○ ● ◐ ◑";
    const result = formatPlainText(input);
    expect(result).toBe("○ ● ◐ ◑");
  });

  it("should preserve numbered emojis", () => {
    const input = "① ② ③ ④ ⑤";
    const result = formatPlainText(input);
    expect(result).toBe("① ② ③ ④ ⑤");
  });

  it("should preserve arrow and symbol emojis", () => {
    const input = "➡ ⬅";
    const result = formatPlainText(input);
    expect(result).toBe("➡ ⬅");
  });

  it("should strip some colorful emojis", () => {
    const input = "✨";
    const result = formatPlainText(input);
    expect(result).toBe("");
  });

  it("should handle empty string", () => {
    const result = formatPlainText("");
    expect(result).toBe("");
  });

  it("should handle mixed content with emojis and markdown", () => {
    const input = "Hello *world*";
    const result = formatPlainText(input);
    expect(result).toBe("Hello \\*world\\*");
  });

  it("should escape all special characters", () => {
    const input = "~#+-=|{}.!\\";
    const result = formatPlainText(input);
    expect(result).toBe("\\~\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
  });
});

describe("formatTelegramMessage", () => {
  it("should convert plain text to MarkdownV2", () => {
    const input = "Hello world";
    const result = formatTelegramMessage(input);
    expect(result).toBe("Hello world\n");
  });

  it("should preserve allowed emojis", () => {
    const input = "Step ① ○ ● ◑";
    const result = formatTelegramMessage(input);
    expect(result).toBe("Step ① ○ ● ◑\n");
  });

  it("should strip colorful emojis", () => {
    const input = "Done ✨";
    const result = formatTelegramMessage(input);
    // Emoji is stripped, trailing newline remains
    expect(result).toBe("Done\n");
  });

  it("should handle empty string", () => {
    const result = formatTelegramMessage("");
    expect(result).toBe("");
  });

  it("should handle numbers list with text", () => {
    const input = "① First step ➡ ② Second step";
    const result = formatTelegramMessage(input);
    expect(result).toBe("① First step ➡ ② Second step\n");
  });
});

describe("emoji filtering integration", () => {
  it("should allow only KISS-valuable black/white emojis", () => {
    const allowed = "○ ◐ ● ◑ ① ② ③ ④ ⑤ ➡ ⬅ ✂";
    const result = formatPlainText(allowed);
    expect(result).toBe(allowed);
  });

  it("should strip colorful emojis in regex ranges", () => {
    const colorful = "✨";
    const result = formatPlainText(colorful);
    expect(result).toBe("");
  });

  it("should handle mixed allowed and rejected emojis", () => {
    const mixed = "○ ✨ ● ◑";
    const result = formatPlainText(mixed);
    expect(result).toBe("○  ● ◑");
  });
});
