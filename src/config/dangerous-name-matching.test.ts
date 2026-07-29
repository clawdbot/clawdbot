// Verifies dangerous config-name matching heuristics.
import { describe, expect, it } from "vitest";
import { resolveDangerousNameMatchingEnabled } from "./dangerous-name-matching.js";

describe("resolveDangerousNameMatchingEnabled", () => {
  it("defaults to false when no provider or account flag is set", () => {
    expect(resolveDangerousNameMatchingEnabled({})).toBe(false);
  });

  it("inherits the provider break-glass flag when the account is unset", () => {
    expect(
      resolveDangerousNameMatchingEnabled({
        providerConfig: { dangerouslyAllowNameMatching: true },
      }),
    ).toBe(true);
  });

  it("lets an account override the provider flag back to false", () => {
    expect(
      resolveDangerousNameMatchingEnabled({
        providerConfig: { dangerouslyAllowNameMatching: true },
        accountConfig: { dangerouslyAllowNameMatching: false },
      }),
    ).toBe(false);
  });

  it("lets an account opt in when the provider flag is false", () => {
    expect(
      resolveDangerousNameMatchingEnabled({
        providerConfig: { dangerouslyAllowNameMatching: false },
        accountConfig: { dangerouslyAllowNameMatching: true },
      }),
    ).toBe(true);
  });
});
