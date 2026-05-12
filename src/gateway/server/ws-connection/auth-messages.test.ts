import { describe, expect, it } from "vitest";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";

describe("formatGatewayAuthFailureMessage", () => {
  it("keeps device-token scope mismatches distinct from token mismatches", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "device-token",
        reason: "scope_mismatch",
      }),
    ).toBe("unauthorized: device token scope mismatch (re-pair or approve scope upgrade)");
  });
});
