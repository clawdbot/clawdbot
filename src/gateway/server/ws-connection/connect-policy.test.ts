// WebSocket connect-policy tests cover Control UI pairing, trusted proxy auth, and device identity policy.
import { describe, expect, test } from "vitest";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  resolveControlUiAuthPolicy,
  shouldClearUnboundScopesForMissingDeviceIdentity,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";

type ControlUiAuthPolicyInput = Parameters<typeof resolveControlUiAuthPolicy>[0];
type DeviceRaw = NonNullable<ControlUiAuthPolicyInput["deviceRaw"]>;
type MissingDeviceIdentityInput = Parameters<typeof evaluateMissingDeviceIdentity>[0];
type MissingDeviceDecisionKind = ReturnType<typeof evaluateMissingDeviceIdentity>["kind"];
type PairingRole = Parameters<typeof shouldSkipControlUiPairing>[1];
type PairingAuthMode = Parameters<typeof shouldSkipControlUiPairing>[3];
type PairingAuthMethod = Parameters<typeof shouldSkipControlUiPairing>[4];
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

function authPolicy(params: Partial<ControlUiAuthPolicyInput> = {}) {
  return resolveControlUiAuthPolicy({
    isControlUi: params.isControlUi ?? false,
    controlUiConfig: params.controlUiConfig,
    deviceRaw: params.deviceRaw ?? null,
  });
}

function expectMissingDeviceDecision(
  overrides: Partial<MissingDeviceIdentityInput>,
  expected: MissingDeviceDecisionKind,
) {
  const isControlUi = overrides.isControlUi ?? false;
  const params: MissingDeviceIdentityInput = {
    hasDeviceIdentity: false,
    role: "operator",
    isControlUi,
    controlUiAuthPolicy: overrides.controlUiAuthPolicy ?? authPolicy({ isControlUi }),
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
  policy: Parameters<typeof shouldSkipControlUiPairing>[0],
  role: PairingRole,
  expected: boolean,
  params: {
    pairingComplete?: boolean;
    authMode?: PairingAuthMode;
    authMethod?: PairingAuthMethod;
  } = {},
) {
  expect(
    shouldSkipControlUiPairing(
      policy,
      role,
      params.pairingComplete ?? false,
      params.authMode,
      params.authMethod,
    ),
  ).toBe(expected);
}

function expectClearsUnboundScopes(overrides: Partial<ClearUnboundScopesInput>, expected: boolean) {
  const params: ClearUnboundScopesInput = {
    decision: { kind: "allow" },
    controlUiAuthPolicy: authPolicy(),
    preserveInsecureLocalControlUiScopes: false,
    authMethod: "token",
    ...overrides,
  };
  expect(shouldClearUnboundScopesForMissingDeviceIdentity(params)).toBe(expected);
}

describe("ws connect policy", () => {
  test("resolves control-ui auth policy", () => {
    const bypass = authPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: deviceRaw("dev-1"),
    });
    expect(bypass.device?.id).toBe("dev-1");

    const regular = authPolicy({
      isControlUi: false,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: deviceRaw("dev-2"),
    });
    expect(regular.device?.id).toBe("dev-2");
  });

  test("evaluates missing-device decisions", () => {
    const policy = authPolicy();
    const controlUiStrict = authPolicy({
      isControlUi: true,
      controlUiConfig: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false },
    });
    const controlUiNoInsecure = authPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: false },
    });
    const bypass = authPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
    });

    expectMissingDeviceDecision(
      {
        hasDeviceIdentity: true,
        role: "node",
        controlUiAuthPolicy: policy,
      },
      "allow",
    );

    // Remote Control UI with allowInsecureAuth -> still rejected.
    expectMissingDeviceDecision(
      {
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        isLocalClient: false,
      },
      "reject-control-ui-insecure-auth",
    );

    // The retired insecure-auth flag no longer bypasses device identity locally.
    expectMissingDeviceDecision(
      {
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        isLocalClient: true,
      },
      "reject-control-ui-insecure-auth",
    );

    // Control UI without allowInsecureAuth, even on localhost -> rejected.
    expectMissingDeviceDecision(
      {
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        isLocalClient: true,
      },
      "reject-control-ui-insecure-auth",
    );

    expectMissingDeviceDecision({ controlUiAuthPolicy: policy }, "allow");

    expectMissingDeviceDecision(
      {
        controlUiAuthPolicy: policy,
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
        controlUiAuthPolicy: policy,
        localBackendSelfPairingOk: true,
        sharedAuthOk: false,
        hasSharedAuth: false,
        isLocalClient: true,
      },
      "reject-device-required",
    );

    expectMissingDeviceDecision(
      {
        controlUiAuthPolicy: policy,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: true,
      },
      "reject-unauthorized",
    );

    expectMissingDeviceDecision(
      {
        role: "node",
        controlUiAuthPolicy: policy,
      },
      "reject-device-required",
    );

    // Trusted-proxy authenticated Control UI should bypass device-identity gating.
    expectMissingDeviceDecision(
      {
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiNoInsecure,
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
        controlUiAuthPolicy: bypass,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
      },
      "reject-control-ui-insecure-auth",
    );

    // Retired bypass input cannot admit device-less node-role registrations.
    expectMissingDeviceDecision(
      {
        role: "node",
        isControlUi: true,
        controlUiAuthPolicy: bypass,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
      },
      "reject-control-ui-insecure-auth",
    );
  });

  test("retired device-auth bypass input does not skip pairing", () => {
    const bypass = authPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
    });
    const strict = authPolicy({ isControlUi: true });

    expectSkipPairing(bypass, "operator", false);
    expectSkipPairing(bypass, "node", false);
    expectSkipPairing(strict, "operator", false);
    expectSkipPairing(strict, "operator", false, { pairingComplete: true });
  });

  test("auth.mode=none skips pairing for operator control-ui only", () => {
    const controlUi = authPolicy({ isControlUi: true });
    const nonControlUi = authPolicy();

    // Control UI + operator + auth.mode=none: skip pairing (the fix for #42931)
    expectSkipPairing(controlUi, "operator", true, { authMode: "none" });
    // Control UI + node role + auth.mode=none: still require pairing
    expectSkipPairing(controlUi, "node", false, { authMode: "none" });
    // Non-Control-UI + operator + auth.mode=none: still require pairing
    // (prevents #43478 regression where ALL clients bypassed pairing)
    expectSkipPairing(nonControlUi, "operator", false, { authMode: "none" });
    // Control UI + operator + auth.mode=shared-key: no change
    expectSkipPairing(controlUi, "operator", false, { authMode: "shared-key" });
    // Control UI + operator + no authMode: no change
    expectSkipPairing(controlUi, "operator", false);
  });

  test("tailscale auth skips pairing only for operator control-ui with device identity", () => {
    const device = deviceRaw("dev-1");
    const controlUiWithDevice = authPolicy({
      isControlUi: true,
      deviceRaw: device,
    });
    const controlUiWithoutDevice = authPolicy({ isControlUi: true });
    const nonControlUiWithDevice = authPolicy({
      deviceRaw: device,
    });

    expectSkipPairing(controlUiWithDevice, "operator", true, {
      authMode: "token",
      authMethod: "tailscale",
    });
    expectSkipPairing(controlUiWithoutDevice, "operator", false, {
      authMode: "token",
      authMethod: "tailscale",
    });
    expectSkipPairing(controlUiWithDevice, "node", false, {
      authMode: "token",
      authMethod: "tailscale",
    });
    expectSkipPairing(nonControlUiWithDevice, "operator", false, {
      authMode: "token",
      authMethod: "tailscale",
    });
    expectSkipPairing(controlUiWithDevice, "operator", false, {
      authMode: "token",
      authMethod: "token",
    });
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
    const nonControlUi = authPolicy();
    const controlUi = authPolicy({
      isControlUi: true,
      controlUiConfig: { allowInsecureAuth: true },
    });

    expectClearsUnboundScopes({ controlUiAuthPolicy: nonControlUi }, true);
    expectClearsUnboundScopes(
      {
        controlUiAuthPolicy: nonControlUi,
        authMethod: "password",
      },
      true,
    );
    expectClearsUnboundScopes(
      {
        controlUiAuthPolicy: nonControlUi,
        authMethod: "trusted-proxy",
      },
      true,
    );
    expectClearsUnboundScopes(
      {
        controlUiAuthPolicy: nonControlUi,
        authMethod: "trusted-proxy",
        trustedProxyAuthOk: true,
      },
      true,
    );
    expectClearsUnboundScopes(
      {
        controlUiAuthPolicy: controlUi,
        preserveInsecureLocalControlUiScopes: true,
      },
      false,
    );
    expectClearsUnboundScopes(
      {
        decision: { kind: "reject-device-required" },
        controlUiAuthPolicy: nonControlUi,
        authMethod: undefined,
      },
      true,
    );
  });
});
