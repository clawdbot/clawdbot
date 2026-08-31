import { describe, expect, it } from "vitest";
import { deriveAvatarInitial } from "./avatar.ts";

describe("deriveAvatarInitial", () => {
  it("returns the uppercased first grapheme for ASCII names", () => {
    expect(deriveAvatarInitial("Alice")).toBe("A");
    expect(deriveAvatarInitial("bob")).toBe("B");
  });

  it("keeps an emoji initial intact instead of a dangling surrogate half", () => {
    expect(deriveAvatarInitial("😀Name")).toBe("😀");
    expect(deriveAvatarInitial("🚀")).toBe("🚀");
  });

  it("preserves complete grapheme clusters for joined emoji and flags", () => {
    expect(deriveAvatarInitial("👨‍👩‍👧‍👦Family")).toBe("👨‍👩‍👧‍👦");
    expect(deriveAvatarInitial("🇺🇸Flag")).toBe("🇺🇸");
    expect(deriveAvatarInitial("👍🏻Thumbs")).toBe("👍🏻");
  });

  it("preserves existing initial casing and whitespace policy", () => {
    expect(deriveAvatarInitial("ßeta")).toBe("SS");
    expect(deriveAvatarInitial(" leading")).toBe(" ");
  });

  it("returns an empty string for empty or missing input", () => {
    expect(deriveAvatarInitial("")).toBe("");
    expect(deriveAvatarInitial(null)).toBe("");
    expect(deriveAvatarInitial(undefined)).toBe("");
  });
});
