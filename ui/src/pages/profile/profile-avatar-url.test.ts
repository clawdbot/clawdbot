// @vitest-environment node
import { describe, expect, it } from "vitest";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";

describe("userProfileAvatarUrl", () => {
  it("builds scoped cache-busted avatar URLs", () => {
    expect(
      userProfileAvatarUrl(
        "wss://gateway.example.test/control",
        "profile/1",
        42,
        "/control",
        "https://gateway.example.test/control/profile",
      ),
    ).toBe("https://gateway.example.test/control/api/users/profile%2F1/avatar?v=42");
    expect(
      userProfileAvatarUrl(
        "wss://remote.example.test",
        "profile-1",
        "content-hash-png",
        "",
        "https://gateway.example.test/control/profile",
      ),
    ).toBe("https://remote.example.test/api/users/profile-1/avatar?v=content-hash-png");
  });
});
