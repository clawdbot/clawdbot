import { ConnectErrorDetailCodes } from "@openclaw/gateway-protocol/connect-error-details";
import { describe, expect, it } from "vitest";
import { shouldPauseGatewayReconnect } from "./reconnect-policy.js";

function shouldPause(details?: unknown): boolean {
  return shouldPauseGatewayReconnect({
    details,
    protocolMismatchIsTerminal: true,
  });
}

describe("shouldPauseGatewayReconnect", () => {
  it.each([
    ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
    ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
    ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
    ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
    ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
    ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
    ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH,
    ConnectErrorDetailCodes.PAIRING_REQUIRED,
    ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
  ])("pauses reconnect for %s", (code) => {
    expect(shouldPause({ code })).toBe(true);
  });

  it("keeps reconnect active when pairing retry hints allow it", () => {
    expect(
      shouldPause({
        code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
        reason: "not-paired",
        recommendedNextStep: "wait_then_retry",
        pauseReconnect: false,
      }),
    ).toBe(false);
  });

  it("leaves token mismatch to the caller's bounded retry policy", () => {
    expect(shouldPause({ code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH })).toBe(false);
  });

  it.each([undefined, {}, { code: "SOME_FUTURE_CODE" }])(
    "keeps reconnect active for recoverable details",
    (details) => {
      expect(shouldPause(details)).toBe(false);
    },
  );
});
