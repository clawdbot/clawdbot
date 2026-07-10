// Control UI tests cover assistant identity behavior.
import { describe, expect, it } from "vitest";
import { normalizeAssistantIdentity } from "./assistant-identity.ts";

const AVATAR_MAX_DATA_URL_CHARS = 4 * Math.ceil((2 * 1024 * 1024) / 3) + 64;

describe("normalizeAssistantIdentity", () => {
  it("truncates names without splitting a surrogate pair", () => {
    expect(normalizeAssistantIdentity({ name: `${"x".repeat(49)}🚀suffix` }).name).toBe(
      "x".repeat(49),
    );
    expect(normalizeAssistantIdentity({ name: `${"x".repeat(48)}🚀suffix` }).name).toBe(
      `${"x".repeat(48)}🚀`,
    );
  });

  it("preserves long image data URLs without truncating past 200 chars", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(50_000)}`;
    expect(normalizeAssistantIdentity({ avatar: dataUrl }).avatar).toBe(dataUrl);
  });

  it("accepts the full local-avatar data URL bound and rejects larger values", () => {
    const prefix = "data:image/svg+xml;base64,";
    const bounded = prefix + "A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length);
    const oversized = `${bounded}A`;

    expect(normalizeAssistantIdentity({ avatar: bounded }).avatar).toBe(bounded);
    expect(normalizeAssistantIdentity({ avatar: oversized }).avatar).toBeNull();
  });

  it("preserves same-origin Control UI avatar routes", () => {
    expect(normalizeAssistantIdentity({ avatar: "/avatar/main" }).avatar).toBe("/avatar/main");
  });

  it("keeps short text avatars", () => {
    expect(normalizeAssistantIdentity({ avatar: "PS" }).avatar).toBe("PS");
    expect(normalizeAssistantIdentity({ avatar: "🦞" }).avatar).toBe("🦞");
  });

  it("drops sentence-like text that exceeds the text-avatar limit", () => {
    const longText = "this is a description, not an emoji or url ".repeat(4);
    expect(normalizeAssistantIdentity({ avatar: longText }).avatar).toBeNull();
  });

  it("drops avatars containing newlines", () => {
    expect(normalizeAssistantIdentity({ avatar: "line1\nline2" }).avatar).toBeNull();
  });
});
