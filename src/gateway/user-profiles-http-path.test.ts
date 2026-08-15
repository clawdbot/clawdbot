import { describe, expect, it } from "vitest";
import {
  canonicalizeUserProfileAvatarPath,
  formatUserProfileAvatarPath,
} from "./user-profiles-http-path.js";

describe("formatUserProfileAvatarPath", () => {
  it("encodes the profile id and appends an optional revision", () => {
    expect(formatUserProfileAvatarPath("profile/a b")).toBe("/api/users/profile%2Fa%20b/avatar");
    expect(formatUserProfileAvatarPath("profile/a b", 1_725_000_123_456)).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=1725000123456",
    );
    expect(formatUserProfileAvatarPath("profile/a b", "hash/image")).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=hash%2Fimage",
    );
  });
});

describe("canonicalizeUserProfileAvatarPath", () => {
  it("preserves the root avatar route", () => {
    expect(canonicalizeUserProfileAvatarPath("/api/users/profile-1/avatar", "/wilfred")).toBe(
      "/api/users/profile-1/avatar",
    );
  });

  it("removes an exact Control UI base-path prefix", () => {
    expect(
      canonicalizeUserProfileAvatarPath("/wilfred/api/users/profile-1/avatar", "/wilfred"),
    ).toBe("/api/users/profile-1/avatar");
  });

  it.each([
    "/wilfred-other/api/users/profile-1/avatar",
    "/wilfred/api/users/profile-1/avatar/extra",
  ])("rejects non-matching alias %s", (pathname) => {
    expect(canonicalizeUserProfileAvatarPath(pathname, "/wilfred")).toBeUndefined();
  });
});
