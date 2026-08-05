import { describe, expect, it } from "vitest";
import { canonicalizeUserProfileAvatarPath } from "./user-profiles-http-path.js";

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
