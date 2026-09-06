/**
 * WebSocket authentication message regression tests.
 */
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { truncateCloseReason } from "../close-reason.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";

describe("formatGatewayAuthFailureMessage", () => {
  it.each(["bootstrap_token_invalid", undefined])(
    "warns that a rejected setup code may already be used for reason %s",
    (reason) => {
      const message = formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "bootstrap-token",
        reason,
      });

      expect(message).toBe(
        "unauthorized: setup code invalid, expired, revoked, or already used (create a new code; review `openclaw devices list`)",
      );
      expect(truncateCloseReason(message)).toBe(message);
    },
  );

  it("keeps device-token scope mismatches distinct from token mismatches", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "device-token",
        reason: "scope_mismatch",
      }),
    ).toBe("unauthorized: device token scope mismatch (re-pair or approve scope upgrade)");
  });

  it("makes a missing Control UI token actionable within the WebSocket close limit", () => {
    const message = formatGatewayAuthFailureMessage({
      authMode: "token",
      authProvided: "none",
      reason: "token_missing",
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    expect(message).toBe(
      "unauthorized: gateway token missing (paste in Control UI settings or openclaw doctor --generate-gateway-token; restart)",
    );
    expect(truncateCloseReason(message)).toBe(message);
  });

  it("points local CLI token mismatches at gateway.auth.token, not gateway.remote", () => {
    const message = formatGatewayAuthFailureMessage({
      authMode: "token",
      authProvided: "token",
      reason: "token_mismatch",
      client: { id: GATEWAY_CLIENT_IDS.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
      isLocalClient: true,
    });

    expect(message).toBe(
      "unauthorized: gateway token mismatch (use this gateway's gateway.auth.token or pair the device)",
    );
    expect(message).not.toContain("gateway.remote");
    expect(truncateCloseReason(message)).toBe(message);
  });

  it("keeps the gateway.remote.token hint for remote CLI token mismatches", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "token",
        reason: "token_mismatch",
        client: { id: GATEWAY_CLIENT_IDS.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
        isLocalClient: false,
      }),
    ).toBe(
      "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
    );
  });

  it("points local CLI password mismatches at gateway.auth.password", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "password",
        authProvided: "password",
        reason: "password_mismatch",
        client: { id: GATEWAY_CLIENT_IDS.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
        isLocalClient: true,
      }),
    ).toBe("unauthorized: gateway password mismatch (use this gateway's gateway.auth.password)");
  });

  it("tells rejected node hosts how to diagnose identity-header auth", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "trusted-proxy",
        authProvided: "none",
        reason: "trusted_proxy_missing_header_cf-access-jwt-assertion",
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
      }),
    ).toBe(
      "gateway rejected this node: trusted-proxy identity-header authentication is required and no usable machine credential was accepted; run `openclaw doctor` on the Gateway",
    );
  });

  it("does not describe other trusted-proxy rejection causes as missing identity headers", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "trusted-proxy",
        authProvided: "none",
        reason: "trusted_proxy_local_interface_check_failed",
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
      }),
    ).toBe("unauthorized");
  });
});
