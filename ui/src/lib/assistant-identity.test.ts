// Control UI tests cover assistant identity behavior.
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, AVATAR_MAX_DATA_URL_CHARS } from "../../../src/shared/avatar-limits.js";
import { normalizeAssistantIdentity } from "./assistant-identity.ts";

describe("normalizeAssistantIdentity", () => {
  it("truncates names without splitting a surrogate pair", () => {
    expect(normalizeAssistantIdentity({ name: `${"x".repeat(49)}🚀suffix` }).name).toBe(
      "x".repeat(49),
    );
    expect(normalizeAssistantIdentity({ name: `${"x".repeat(48)}🚀suffix` }).name).toBe(
      `${"x".repeat(48)}🚀`,
    );
  });

  it("preserves a maximum-size encoded local avatar above the old UI limit", () => {
    const encoded = Buffer.alloc(AVATAR_MAX_BYTES).toString("base64");
    const dataUrl = `data:image/svg+xml;base64,${encoded}`;
    expect(dataUrl.length).toBeGreaterThan(2_000_000);
    expect(dataUrl).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
    expect(normalizeAssistantIdentity({ avatar: dataUrl }).avatar).toBe(dataUrl);
  });

  it("rejects oversized data URLs instead of truncating them into corrupt images", () => {
    const oversized = `data:image/png;base64,${"A".repeat(AVATAR_MAX_DATA_URL_CHARS)}`;
    expect(oversized.length).toBeGreaterThan(AVATAR_MAX_DATA_URL_CHARS);
    expect(normalizeAssistantIdentity({ avatar: oversized }).avatar).toBeNull();
  });

  it.each(["data:text/plain,avatar", "https://example.com/avatar.png", "javascript:alert(1)"])(
    "rejects unsupported URI avatars instead of displaying them as text: %s",
    (avatar) => {
      expect(normalizeAssistantIdentity({ avatar }).avatar).toBeNull();
    },
  );

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
