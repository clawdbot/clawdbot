import { describe, it, expect } from "vitest";
import { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";

describe("isNonRecoverableSlackAuthError", () => {
  it.each([
    "An API error occurred: account_inactive",
    "An API error occurred: invalid_auth",
    "An API error occurred: token_revoked",
    "An API error occurred: token_expired",
    "An API error occurred: not_authed",
    "An API error occurred: org_login_required",
    "An API error occurred: team_access_not_granted",
    "An API error occurred: missing_scope",
    "An API error occurred: cannot_find_service",
    "An API error occurred: invalid_token",
  ])("returns true for non-recoverable error: %s", (msg) => {
    expect(isNonRecoverableSlackAuthError(new Error(msg))).toBe(true);
  });

  it("returns true when error is a plain string", () => {
    expect(isNonRecoverableSlackAuthError("account_inactive")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isNonRecoverableSlackAuthError(new Error("ACCOUNT_INACTIVE"))).toBe(true);
    expect(isNonRecoverableSlackAuthError(new Error("Invalid_Auth"))).toBe(true);
  });

  it.each([
    "Connection timed out",
    "ECONNRESET",
    "Network request failed",
    "socket hang up",
    "ETIMEDOUT",
    "rate_limited",
  ])("returns false for recoverable/transient error: %s", (msg) => {
    expect(isNonRecoverableSlackAuthError(new Error(msg))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isNonRecoverableSlackAuthError(null)).toBe(false);
    expect(isNonRecoverableSlackAuthError(undefined)).toBe(false);
    expect(isNonRecoverableSlackAuthError(42)).toBe(false);
    expect(isNonRecoverableSlackAuthError({})).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isNonRecoverableSlackAuthError("")).toBe(false);
    expect(isNonRecoverableSlackAuthError(new Error(""))).toBe(false);
  });
});
