// Mattermost tests cover emoji reaction name normalization.
import { describe, expect, it } from "vitest";
import { normalizeMattermostEmojiName } from "./emoji.js";

describe("normalizeMattermostEmojiName", () => {
  it("maps a raw Unicode glyph to a Mattermost short name (the server rejects raw glyphs)", () => {
    expect(normalizeMattermostEmojiName("👍")).toBe("thumbsup");
    expect(normalizeMattermostEmojiName("✅")).toBe("white_check_mark");
    expect(normalizeMattermostEmojiName("🎉")).toBe("tada");
  });

  it("preserves the skin tone as Mattermost's toned short name", () => {
    expect(normalizeMattermostEmojiName("👍🏽")).toBe("thumbsup_medium_skin_tone");
    expect(normalizeMattermostEmojiName("🙌🏿")).toBe("raised_hands_dark_skin_tone");
    // Accepted tradeoff: a modifier on a non-modifier base is not a real emoji
    // sequence, so the stray tone is dropped instead of composing an unknown name.
    expect(normalizeMattermostEmojiName("🔥\u{1F3FD}")).toBe("fire");
  });

  it("strips variation selectors before lookup", () => {
    expect(normalizeMattermostEmojiName("⚠️")).toBe("warning");
  });

  it("accepts an existing short name with or without wrapping colons", () => {
    expect(normalizeMattermostEmojiName("thumbsup")).toBe("thumbsup");
    expect(normalizeMattermostEmojiName(":thumbsup:")).toBe("thumbsup");
    expect(normalizeMattermostEmojiName(":+1:")).toBe("+1");
  });

  it("passes through an unknown glyph or short name unchanged (no regression)", () => {
    expect(normalizeMattermostEmojiName("custom_emoji")).toBe("custom_emoji");
    expect(normalizeMattermostEmojiName("🫶")).toBe("🫶");
    expect(normalizeMattermostEmojiName("constructor")).toBe("constructor");
    expect(normalizeMattermostEmojiName("toString")).toBe("toString");
    expect(normalizeMattermostEmojiName("__proto__")).toBe("__proto__");
  });

  it("returns undefined for blank input", () => {
    expect(normalizeMattermostEmojiName(undefined)).toBeUndefined();
    expect(normalizeMattermostEmojiName("   ")).toBeUndefined();
    expect(normalizeMattermostEmojiName("::")).toBeUndefined();
  });
});
