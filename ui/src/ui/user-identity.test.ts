import { describe, expect, it } from "vitest";
import {
  normalizeLocalUserIdentity,
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
  resolveLocalUserName,
} from "./user-identity.ts";

describe("local user identity helpers", () => {
  it("normalizes the display name with the same fallback used by chat", () => {
    expect(resolveLocalUserName({ name: "  Val  " })).toBe("Val");
    expect(resolveLocalUserName({ name: "   " })).toBe("You");
  });

  it("resolves renderable local avatar URLs through the shared chat path", () => {
    expect(resolveLocalUserAvatarUrl({ avatar: "/avatar/user" })).toBe("/avatar/user");
    expect(resolveLocalUserAvatarUrl({ avatar: "data:image/png;base64,AAA" })).toBe(
      "data:image/png;base64,AAA",
    );
    expect(resolveLocalUserAvatarUrl({ avatar: "https://example.com/avatar.png" })).toBeNull();
  });

  it("keeps text avatars only when no image avatar survives normalization", () => {
    expect(resolveLocalUserAvatarText({ avatar: "🦞" })).toBe("🦞");
    expect(resolveLocalUserAvatarText({ avatar: "/avatar/user" })).toBeNull();
    expect(normalizeLocalUserIdentity({ avatar: "line 1\nline 2" }).avatar).toBeNull();
  });
});
