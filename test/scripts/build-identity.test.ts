import { describe, expect, it, vi } from "vitest";
import { resolveBuildIdentityEnvironment } from "../../scripts/lib/build-identity.mts";

describe("resolveBuildIdentityEnvironment", () => {
  it.each([
    {
      env: { GIT_COMMIT: "A".repeat(40), GIT_SHA: "b".repeat(40) },
      expected: "a".repeat(40),
      readsCheckout: false,
    },
    {
      env: { GIT_SHA: "B".repeat(40), GITHUB_SHA: "c".repeat(40) },
      expected: "b".repeat(40),
      readsCheckout: false,
    },
    {
      env: { GITHUB_SHA: "c".repeat(40) },
      expected: "d".repeat(40),
      readsCheckout: true,
    },
  ])("preserves build source precedence %#", ({ env, expected, readsCheckout }) => {
    const readGitCommit = vi.fn(() => "D".repeat(40));
    const resolved = resolveBuildIdentityEnvironment({
      commitLabel: "build commit",
      env,
      now: () => new Date("2026-07-10T12:34:56.000Z"),
      readGitCommit,
    });

    expect(resolved.GIT_COMMIT).toBe(expected);
    expect(readGitCommit).toHaveBeenCalledTimes(readsCheckout ? 1 : 0);
  });

  it("uses workflow identity only when the checkout cannot be read", () => {
    expect(
      resolveBuildIdentityEnvironment({
        commitLabel: "runtime pack commit",
        env: {
          GITHUB_SHA: "e".repeat(40),
          OPENCLAW_BUILD_TIMESTAMP: " 2026-07-10T01:02:03.000Z ",
        },
        now: () => new Date("2026-07-11T12:34:56.000Z"),
        readGitCommit: () => null,
      }),
    ).toMatchObject({
      GIT_COMMIT: "e".repeat(40),
      OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.000Z",
    });
  });

  it("uses the owner label in malformed commit diagnostics", () => {
    expect(() =>
      resolveBuildIdentityEnvironment({
        commitLabel: "runtime pack commit",
        env: { GIT_COMMIT: "deadbeef" },
        readGitCommit: () => null,
      }),
    ).toThrow("runtime pack commit must be a full 40-character hexadecimal SHA");
  });
});
