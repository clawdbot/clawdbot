import { describe, expect, it } from "vitest";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";

describe("resolveAuthProfileFailureReason", () => {
  it("records shared non-timeout provider failures", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "billing",
        policy: "shared",
      }),
    ).toBe("billing");
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "rate_limit",
        policy: "shared",
      }),
    ).toBe("rate_limit");
  });

  it("does not record local helper failures in shared auth state", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "billing",
        policy: "local",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "auth",
        policy: "local",
      }),
    ).toBeNull();
  });

  it("does not persist transport timeouts as auth-profile health", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
      }),
    ).toBeNull();
  });

  it("does not persist request-shape (format) rejections as auth-profile health (#77228)", () => {
    // A format rejection (e.g. the github-copilot prefill-strict 400
    // "conversation must end with a user message" reported in #77228) is
    // a per-session transcript-shape problem; cascading it to a profile
    // cooldown blocks every other healthy session sharing the same auth
    // profile and can take down the whole provider for the backoff window.
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "format",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "format",
        policy: "shared",
      }),
    ).toBeNull();
  });
});
