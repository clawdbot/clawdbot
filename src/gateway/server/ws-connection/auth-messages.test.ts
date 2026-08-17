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
