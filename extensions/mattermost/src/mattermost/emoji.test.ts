// Mattermost tests cover emoji reaction name normalization.
import { describe, expect, it } from "vitest";
import { normalizeMattermostEmojiName } from "./emoji.js";

describe("normalizeMattermostEmojiName", () => {
  it("maps a raw Unicode glyph to a Mattermost short name (the server rejects raw glyphs)", () => {
    expect(normalizeMattermostEmojiName("👍")).toBe("thumbsup");
    expect(normalizeMattermostEmojiName("✅")).toBe("white_check_mark");
    expect(normalizeMattermostEmojiName("🎉")).toBe("tada");
  });

  it("strips skin-tone modifiers and variation selectors before lookup", () => {
    expect(normalizeMattermostEmojiName("👍🏽")).toBe("thumbsup");
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
