import { describe, expect, test } from "vitest";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  resolveControlUiAuthPolicy,
  shouldClearUnboundScopesForMissingDeviceIdentity,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";

describe("ws connect policy", () => {
  test("resolves control-ui auth policy", () => {
    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-1",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
        nonce: "nonce-1",
      },
    });
    expect(bypass.allowBypass).toBe(true);
    expect(bypass.device).toBeNull();

    const regular = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-2",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
        nonce: "nonce-2",
      },
    });
    expect(regular.allowBypass).toBe(false);
    expect(regular.device?.id).toBe("dev-2");
  });

  test("evaluates missing-device decisions", () => {
    const policy = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: undefined,
      deviceRaw: null,
    });

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: true,
        role: "node",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    const controlUiStrict = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
    });
    // Remote Control UI with allowInsecureAuth -> still rejected.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    // Local Control UI with allowInsecureAuth -> allowed.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: true,
      }).kind,
    ).toBe("allow");

    // Control UI without allowInsecureAuth, even on localhost -> rejected.
    const controlUiNoInsecure = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
    });
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: true,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        localBackendSelfPairingOk: true,
        sharedAuthOk: false,
        authOk: true,
        hasSharedAuth: false,
        isLocalClient: true,
      }).kind,
    ).toBe("allow");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "node",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        localBackendSelfPairingOk: true,
        sharedAuthOk: false,
        authOk: true,
        hasSharedAuth: false,
        isLocalClient: true,
      }).kind,
    ).toBe("reject-device-required");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-unauthorized");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "node",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-device-required");

    // Trusted-proxy authenticated Control UI should bypass device-identity gating.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        trustedProxyAuthOk: true,
        sharedAuthOk: false,
        authOk: true,
        hasSharedAuth: false,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: null,
    });
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: bypass,
        trustedProxyAuthOk: false,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    // Regression: dangerouslyDisableDeviceAuth bypass must NOT extend to node-role
    // sessions — the break-glass flag is scoped to operator Control UI only.
    // A device-less node-role connection must still be rejected even when the flag
    // is set, to prevent the flag from being abused to admit unauthorized node
    // registrations.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "node",
        isControlUi: true,
        controlUiAuthPolicy: bypass,
        trustedProxyAuthOk: false,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-device-required");
  });

  test("dangerouslyDisableDeviceAuth skips pairing for operator control-ui only", () => {
    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: null,
    });
    const strict = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: undefined,
      deviceRaw: null,
    });
    expect(shouldSkipControlUiPairing(bypass, "operator", false)).toBe(true);
    expect(shouldSkipControlUiPairing(bypass, "node", false)).toBe(false);
    expect(shouldSkipControlUiPairing(strict, "operator", false)).toBe(false);
    expect(shouldSkipControlUiPairing(strict, "operator", true)).toBe(true);
  });

  test("auth.mode=none skips pairing for operator control-ui only", () => {
    const controlUi = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: undefined,
      deviceRaw: null,
    });
    const nonControlUi = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: undefined,
      deviceRaw: null,
    });
    // Control UI + operator + auth.mode=none: skip pairing (the fix for #42931)
    expect(shouldSkipControlUiPairing(controlUi, "operator", false, "none")).toBe(true);
    // Control UI + node role + auth.mode=none: still require pairing
    expect(shouldSkipControlUiPairing(controlUi, "node", false, "none")).toBe(false);
    // Non-Control-UI + operator + auth.mode=none: still require pairing
    // (prevents #43478 regression where ALL clients bypassed pairing)
    expect(shouldSkipControlUiPairing(nonControlUi, "operator", false, "none")).toBe(false);
    // Control UI + operator + auth.mode=shared-key: no change
    expect(shouldSkipControlUiPairing(controlUi, "operator", false, "shared-key")).toBe(false);
    // Control UI + operator + no authMode: no change
    expect(shouldSkipControlUiPairing(controlUi, "operator", false)).toBe(false);
  });

  test("tailscale auth skips pairing only for operator control-ui with device identity", () => {
    const device = {
      id: "dev-1",
      publicKey: "pk",
      signature: "sig",
      signedAt: Date.now(),
      nonce: "nonce-1",
    };
    const controlUiWithDevice = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: undefined,
      deviceRaw: device,
    });
    const controlUiWithoutDevice = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: undefined,
      deviceRaw: null,
    });
    const nonControlUiWithDevice = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: undefined,
      deviceRaw: device,
    });

    expect(
      shouldSkipControlUiPairing(controlUiWithDevice, "operator", false, "token", "tailscale"),
    ).toBe(true);
    expect(
      shouldSkipControlUiPairing(controlUiWithoutDevice, "operator", false, "token", "tailscale"),
    ).toBe(false);
    expect(
      shouldSkipControlUiPairing(controlUiWithDevice, "node", false, "token", "tailscale"),
    ).toBe(false);
    expect(
      shouldSkipControlUiPairing(nonControlUiWithDevice, "operator", false, "token", "tailscale"),
    ).toBe(false);
    expect(
      shouldSkipControlUiPairing(controlUiWithDevice, "operator", false, "token", "token"),
    ).toBe(false);
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
    const nonControlUi = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: undefined,
      deviceRaw: null,
    });
    const controlUi = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { allowInsecureAuth: true },
      deviceRaw: null,
    });

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        decision: { kind: "allow" },
        controlUiAuthPolicy: nonControlUi,
        preserveInsecureLocalControlUiScopes: false,
        authMethod: "token",
      }),
    ).toBe(true);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        decision: { kind: "allow" },
        controlUiAuthPolicy: nonControlUi,
        preserveInsecureLocalControlUiScopes: false,
        authMethod: "password",
      }),
    ).toBe(true);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        decision: { kind: "allow" },
        controlUiAuthPolicy: nonControlUi,
        preserveInsecureLocalControlUiScopes: false,
        authMethod: "trusted-proxy",
      }),
    ).toBe(true);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        decision: { kind: "allow" },
        controlUiAuthPolicy: nonControlUi,
        preserveInsecureLocalControlUiScopes: false,
        authMethod: undefined,
        trustedProxyAuthOk: true,
      }),
    ).toBe(false);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        decision: { kind: "allow" },
        controlUiAuthPolicy: controlUi,
        preserveInsecureLocalControlUiScopes: true,
        authMethod: "token",
      }),
    ).toBe(false);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        decision: { kind: "reject-device-required" },
        controlUiAuthPolicy: nonControlUi,
        preserveInsecureLocalControlUiScopes: false,
        authMethod: undefined,
      }),
    ).toBe(true);
  });
});
