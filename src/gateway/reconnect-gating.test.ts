import { describe, expect, it } from "vitest";
import { type GatewayErrorInfo, isNonRecoverableAuthError } from "../../ui/src/ui/gateway.ts";
import { ConnectErrorDetailCodes } from "./protocol/connect-error-details.js";

function makeError(detailCode: string): GatewayErrorInfo {
  return { code: "connect_failed", message: "auth failed", details: { code: detailCode } };
}

describe("isNonRecoverableAuthError", () => {
  it("returns false for undefined error (normal disconnect)", () => {
    expect(isNonRecoverableAuthError(undefined)).toBe(false);
  });

  it("returns false for errors without detail codes (network issues)", () => {
    expect(isNonRecoverableAuthError({ code: "connect_failed", message: "timeout" })).toBe(false);
  });

  it("blocks reconnect for AUTH_TOKEN_MISSING (misconfigured client)", () => {
    expect(isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.AUTH_TOKEN_MISSING))).toBe(
      true,
    );
  });

  it("blocks reconnect for AUTH_BOOTSTRAP_TOKEN_INVALID", () => {
    expect(
      isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID)),
    ).toBe(true);
  });

  it("blocks reconnect for AUTH_PASSWORD_MISSING", () => {
    expect(
      isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING)),
    ).toBe(true);
  });

  it("blocks reconnect for AUTH_PASSWORD_MISMATCH (wrong password won't self-correct)", () => {
    expect(
      isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH)),
    ).toBe(true);
  });

  it("blocks reconnect for AUTH_RATE_LIMITED (reconnecting burns more slots)", () => {
    expect(isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.AUTH_RATE_LIMITED))).toBe(
      true,
    );
  });

  it("blocks reconnect for AUTH_DEVICE_TOKEN_MISMATCH", () => {
    expect(
      isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH)),
    ).toBe(true);
  });

  it("blocks reconnect for PAIRING_REQUIRED", () => {
    expect(isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.PAIRING_REQUIRED))).toBe(
      true,
    );
  });

  it("allows reconnect for AUTH_TOKEN_MISMATCH (device-token fallback flow)", () => {
    // Browser client can queue a single trusted-device retry after shared token mismatch.
    // Blocking reconnect on mismatch here would skip that bounded recovery attempt.
    expect(isNonRecoverableAuthError(makeError(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH))).toBe(
      false,
    );
  });

  it("allows reconnect for unrecognized detail codes (future-proof)", () => {
    expect(isNonRecoverableAuthError(makeError("SOME_FUTURE_CODE"))).toBe(false);
  });
});
