import { describe, expect, it } from "vitest";
import { normalizeAssistantIdentity } from "./assistant-identity.ts";

describe("normalizeAssistantIdentity", () => {
  it("preserves long image data URLs without truncating past 200 chars", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(50_000)}`;
    expect(normalizeAssistantIdentity({ avatar: dataUrl }).avatar).toBe(dataUrl);
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
