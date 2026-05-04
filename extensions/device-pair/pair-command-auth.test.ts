import { describe, expect, it } from "vitest";
import { resolvePairingCommandAuthState } from "./pair-command-auth.js";

describe("device-pair pairing command auth", () => {
  it("fails closed for non-gateway channels without pairing scopes", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "telegram",
        gatewayClientScopes: undefined,
      }),
    ).toEqual({
      isInternalGatewayCaller: false,
      isMissingPairingPrivilege: true,
      approvalCallerScopes: undefined,
    });
  });

  it("accepts command owners on non-gateway channels", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "telegram",
        gatewayClientScopes: undefined,
        senderIsOwner: true,
      }),
    ).toEqual({
      isInternalGatewayCaller: false,
      isMissingPairingPrivilege: false,
      approvalCallerScopes: ["operator.pairing"],
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
      isMissingPairingPrivilege: true,
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
      isMissingPairingPrivilege: false,
      approvalCallerScopes: ["operator.write", "operator.pairing"],
    });
    expect(
      resolvePairingCommandAuthState({
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      }),
    ).toEqual({
      isInternalGatewayCaller: true,
      isMissingPairingPrivilege: false,
      approvalCallerScopes: ["operator.admin"],
    });
  });

  it("preserves gateway scopes for command owners with gateway scope context", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "telegram",
        gatewayClientScopes: ["operator.write", "operator.pairing"],
        senderIsOwner: true,
      }),
    ).toEqual({
      isInternalGatewayCaller: true,
      isMissingPairingPrivilege: false,
      approvalCallerScopes: ["operator.write", "operator.pairing"],
    });
  });
});
