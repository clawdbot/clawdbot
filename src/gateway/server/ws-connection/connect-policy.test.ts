// WebSocket connect-policy tests cover Control UI pairing, trusted proxy auth, and device identity policy.
import { describe, expect, test } from "vitest";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  shouldClearUnboundScopesForMissingDeviceIdentity,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";

type SkipPairingInput = Parameters<typeof shouldSkipControlUiPairing>[0];
type DeviceRaw = NonNullable<SkipPairingInput["device"]>;
type MissingDeviceIdentityInput = Parameters<typeof evaluateMissingDeviceIdentity>[0];
type MissingDeviceDecisionKind = ReturnType<typeof evaluateMissingDeviceIdentity>["kind"];
type ClearUnboundScopesInput = Parameters<
  typeof shouldClearUnboundScopesForMissingDeviceIdentity
>[0];

function deviceRaw(id: string): DeviceRaw {
  return {
    id,
    publicKey: "pk",
    signature: "sig",
    signedAt: Date.now(),
    nonce: `${id}-nonce`,
  };
}

function expectMissingDeviceDecision(
  overrides: Partial<MissingDeviceIdentityInput>,
  expected: MissingDeviceDecisionKind,
) {
  const params: MissingDeviceIdentityInput = {
    hasDeviceIdentity: false,
    role: "operator",
    isControlUi: false,
    trustedProxyAuthOk: false,
    sharedAuthOk: true,
    authOk: true,
    hasSharedAuth: true,
    isLocalClient: false,
    ...overrides,
  };
  expect(evaluateMissingDeviceIdentity(params).kind).toBe(expected);
}

function expectSkipPairing(
  overrides: Partial<SkipPairingInput>,
  expected: ReturnType<typeof shouldSkipControlUiPairing>,
) {
  expect(
    shouldSkipControlUiPairing({
      isControlUi: false,
      device: null,
      role: "operator",
      ...overrides,
    }),
  ).toBe(expected);
}

function expectClearsUnboundScopes(overrides: Partial<ClearUnboundScopesInput>, expected: boolean) {
  const params: ClearUnboundScopesInput = {
    decision: { kind: "allow" },
    authMethod: "token",
    ...overrides,
  };
  expect(shouldClearUnboundScopesForMissingDeviceIdentity(params)).toBe(expected);
}

describe("ws connect policy", () => {
  test("evaluates missing-device decisions", () => {
    expectMissingDeviceDecision({ hasDeviceIdentity: true, role: "node" }, "allow");

    expectMissingDeviceDecision(
      { role: "operator", isControlUi: true, isLocalClient: false },
      "reject-control-ui-insecure-auth",
    );

    expectMissingDeviceDecision(
      { role: "operator", isControlUi: true, isLocalClient: true },
      "reject-control-ui-insecure-auth",
    );

    expectMissingDeviceDecision({}, "allow");

    expectMissingDeviceDecision(
      {
        localBackendSelfPairingOk: true,
        sharedAuthOk: false,
        hasSharedAuth: false,
        isLocalClient: true,
      },
      "allow",
    );

    expectMissingDeviceDecision(
      {
        role: "node",
        localBackendSelfPairingOk: true,
        sharedAuthOk: false,
        hasSharedAuth: false,
        isLocalClient: true,
      },
      "reject-device-required",
    );

    expectMissingDeviceDecision(
      { sharedAuthOk: false, authOk: false, hasSharedAuth: true },
      "reject-unauthorized",
    );

    expectMissingDeviceDecision({ role: "node" }, "reject-device-required");

    // Trusted-proxy authenticated Control UI should bypass device-identity gating.
    expectMissingDeviceDecision(
      {
        role: "operator",
        isControlUi: true,
        trustedProxyAuthOk: true,
        sharedAuthOk: false,
        hasSharedAuth: false,
      },
      "allow",
    );

    expectMissingDeviceDecision(
      {
        role: "operator",
        isControlUi: true,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
      },
      "reject-control-ui-insecure-auth",
    );

    expectMissingDeviceDecision(
      {
        role: "node",
        isControlUi: true,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
      },
      "reject-control-ui-insecure-auth",
    );
  });

  test("strict control-ui policy does not skip pairing", () => {
    expectSkipPairing({ isControlUi: true, role: "node" }, null);
    expectSkipPairing({ isControlUi: true, role: "operator" }, null);
  });

  test("auth.mode=none skips pairing for operator control-ui only", () => {
    // Control UI + operator + auth.mode=none: skip pairing (the fix for #42931)
    expectSkipPairing({ isControlUi: true, role: "operator", authMode: "none" }, "auth-none");
    // Control UI + node role + auth.mode=none: still require pairing
    expectSkipPairing({ isControlUi: true, role: "node", authMode: "none" }, null);
    // Non-Control-UI + operator + auth.mode=none: still require pairing
    // (prevents #43478 regression where ALL clients bypassed pairing)
    expectSkipPairing({ role: "operator", authMode: "none" }, null);
    // Control UI + operator + auth.mode=shared-key: no change
    expectSkipPairing({ isControlUi: true, role: "operator", authMode: "shared-key" }, null);
    // Control UI + operator + no authMode: no change
    expectSkipPairing({ isControlUi: true, role: "operator" }, null);
  });

  test("tailscale auth skips pairing only for operator control-ui with device identity", () => {
    const device = deviceRaw("dev-1");

    expectSkipPairing(
      { isControlUi: true, device, role: "operator", authMode: "token", authMethod: "tailscale" },
      "tailscale-device",
    );
    expectSkipPairing(
      { isControlUi: true, role: "operator", authMode: "token", authMethod: "tailscale" },
      null,
    );
    expectSkipPairing(
      { isControlUi: true, device, role: "node", authMode: "token", authMethod: "tailscale" },
      null,
    );
    expectSkipPairing(
      { device, role: "operator", authMode: "token", authMethod: "tailscale" },
      null,
    );
    expectSkipPairing(
      { isControlUi: true, device, role: "operator", authMode: "token", authMethod: "token" },
      null,
    );
  });

  test("trusted-proxy control-ui bypass only applies to operator + trusted-proxy auth", () => {
    const cases: Array<{
      role: "operator" | "node";
      authMode: string;
      authOk: boolean;
      authMethod: string | undefined;
      expected: boolean;
    }> = [
      {
        role: "operator",
        authMode: "trusted-proxy",
        authOk: true,
        authMethod: "trusted-proxy",
        expected: true,
      },
      {
        role: "node",
        authMode: "trusted-proxy",
        authOk: true,
        authMethod: "trusted-proxy",
        expected: false,
      },
      {
        role: "operator",
        authMode: "token",
        authOk: true,
        authMethod: "token",
        expected: false,
      },
      {
        role: "operator",
        authMode: "trusted-proxy",
        authOk: false,
        authMethod: "trusted-proxy",
        expected: false,
      },
    ];

    for (const tc of cases) {
      expect(
        isTrustedProxyControlUiOperatorAuth({
          isControlUi: true,
          role: tc.role,
          authMode: tc.authMode,
          authOk: tc.authOk,
          authMethod: tc.authMethod,
        }),
      ).toBe(tc.expected);
    }
  });

  test("clears unbound scopes for device-less shared auth outside explicit preservation cases", () => {
    expectClearsUnboundScopes({}, true);
    expectClearsUnboundScopes({ authMethod: "password" }, true);
    expectClearsUnboundScopes({ authMethod: "trusted-proxy" }, true);
    expectClearsUnboundScopes({ authMethod: undefined }, false);
    expectClearsUnboundScopes(
      { decision: { kind: "reject-device-required" }, authMethod: undefined },
      true,
    );
  });
});
