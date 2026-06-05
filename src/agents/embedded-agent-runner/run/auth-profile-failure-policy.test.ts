// Coverage for deciding which failover reasons affect auth profile health.
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

  it("only persists timeouts when the provider request started", () => {
    // Pre-provider timeout says nothing about credential health; started
    // provider timeouts can cool down the active profile.
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
        providerStarted: false,
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
        providerStarted: true,
      }),
    ).toBe("timeout");
  });

  it("does not persist transport or server failures as auth-profile health", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "server_error",
      }),
    ).toBeNull();
  });

  it("does not persist empty responses as auth-profile health", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "empty_response",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "empty_response",
        policy: "shared",
      }),
    ).toBeNull();
  });

  it("does not persist request-shape (format) rejections as auth-profile health (#77228)", () => {
    // Format rejections are transcript/request-shape problems, not shared
    // credential failures.
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
