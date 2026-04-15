import { describe, expect, it } from "vitest";
import { resolvePairingCommandAuthState } from "./pair-command-auth.js";

describe("device-pair pairing command auth", () => {
  it("treats non-gateway channels as external approvals", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "telegram",
        gatewayClientScopes: undefined,
      }),
    ).toEqual({
      isInternalGatewayCaller: false,
      isMissingInternalPairingPrivilege: false,
      approvalCallerScopes: undefined,
    });
  });

  it("fails closed for webchat when scopes are absent", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "webchat",
        gatewayClientScopes: undefined,
      }),
    ).toEqual({
      isInternalGatewayCaller: true,
      isMissingInternalPairingPrivilege: true,
      approvalCallerScopes: [],
    });
  });

  it("accepts pairing and admin scopes for internal callers", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "webchat",
        gatewayClientScopes: ["operator.write", "operator.pairing"],
      }),
    ).toEqual({
      isInternalGatewayCaller: true,
      isMissingInternalPairingPrivilege: false,
      approvalCallerScopes: ["operator.write", "operator.pairing"],
    });
    expect(
      resolvePairingCommandAuthState({
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      }),
    ).toEqual({
      isInternalGatewayCaller: true,
      isMissingInternalPairingPrivilege: false,
      approvalCallerScopes: ["operator.admin"],
    });
  });
});
