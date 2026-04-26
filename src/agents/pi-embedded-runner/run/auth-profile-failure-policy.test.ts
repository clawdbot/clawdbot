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
});
