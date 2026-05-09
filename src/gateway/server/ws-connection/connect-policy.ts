import type { ConnectParams } from "../../protocol/index.js";
import type { GatewayRole } from "../../role-policy.js";
import { roleCanSkipDeviceIdentity } from "../../role-policy.js";

export type ControlUiAuthPolicy = {
  isControlUi: boolean;
  allowInsecureAuthConfigured: boolean;
  dangerouslyDisableDeviceAuth: boolean;
  allowBypass: boolean;
  device: ConnectParams["device"] | null | undefined;
};

export function resolveControlUiAuthPolicy(params: {
  isControlUi: boolean;
  controlUiConfig:
    | {
        allowInsecureAuth?: boolean;
        dangerouslyDisableDeviceAuth?: boolean;
      }
    | undefined;
  deviceRaw: ConnectParams["device"] | null | undefined;
}): ControlUiAuthPolicy {
  const allowInsecureAuthConfigured =
    params.isControlUi && params.controlUiConfig?.allowInsecureAuth === true;
  const dangerouslyDisableDeviceAuth =
    params.isControlUi && params.controlUiConfig?.dangerouslyDisableDeviceAuth === true;
  return {
    isControlUi: params.isControlUi,
    allowInsecureAuthConfigured,
    dangerouslyDisableDeviceAuth,
    // `allowInsecureAuth` must not bypass secure-context/device-auth requirements.
    allowBypass: dangerouslyDisableDeviceAuth,
    device: dangerouslyDisableDeviceAuth ? null : params.deviceRaw,
  };
}

export function shouldSkipControlUiPairing(
  policy: ControlUiAuthPolicy,
  role: GatewayRole,
  trustedProxyAuthOk = false,
  authMode?: string,
  authMethod?: string,
): boolean {
  if (trustedProxyAuthOk) {
    return true;
  }
  if (policy.isControlUi && role === "operator" && authMethod === "tailscale" && policy.device) {
    return true;
  }
  // When auth is completely disabled (mode=none), there is no shared secret
  // or token to gate pairing. Requiring pairing in this configuration adds
  // friction without security value since any client can already connect
  // without credentials. Guard with policy.isControlUi because this function
  // is called for ALL clients (not just Control UI) at the call site.
  // Scope to operator role so node-role sessions still need device identity
  // (#43478 was reverted for skipping ALL clients).
  if (policy.isControlUi && role === "operator" && authMode === "none") {
    return true;
  }
  // dangerouslyDisableDeviceAuth is the break-glass path for Control UI
  // operators. Keep pairing aligned with the missing-device bypass, including
  // open-auth deployments where there is no shared token/password to prove.
  return role === "operator" && policy.allowBypass;
}

export function isTrustedProxyControlUiOperatorAuth(params: {
  isControlUi: boolean;
  role: GatewayRole;
  authMode: string;
  authOk: boolean;
  authMethod: string | undefined;
}): boolean {
  return (
    params.isControlUi &&
    params.role === "operator" &&
    params.authMode === "trusted-proxy" &&
    params.authOk &&
    params.authMethod === "trusted-proxy"
  );
}

export type MissingDeviceIdentityDecision =
  | { kind: "allow" }
  | { kind: "reject-control-ui-insecure-auth" }
  | { kind: "reject-unauthorized" }
  | { kind: "reject-device-required" };

export function shouldClearUnboundScopesForMissingDeviceIdentity(params: {
  decision: MissingDeviceIdentityDecision;
  controlUiAuthPolicy: ControlUiAuthPolicy;
  preserveInsecureLocalControlUiScopes: boolean;
  authMethod: string | undefined;
  trustedProxyAuthOk?: boolean;
}): boolean {
  return (
    params.decision.kind !== "allow" ||
    (!params.controlUiAuthPolicy.allowBypass &&
      !params.preserveInsecureLocalControlUiScopes &&
      params.trustedProxyAuthOk !== true &&
      // trusted-proxy auth can bypass pairing for some clients, but those
      // self-declared scopes are still unbound without device identity.
      (params.authMethod === "token" ||
        params.authMethod === "password" ||
        params.authMethod === "trusted-proxy"))
  );
}

export function evaluateMissingDeviceIdentity(params: {
  hasDeviceIdentity: boolean;
  role: GatewayRole;
  isControlUi: boolean;
  controlUiAuthPolicy: ControlUiAuthPolicy;
  trustedProxyAuthOk?: boolean;
  localBackendSelfPairingOk?: boolean;
  sharedAuthOk: boolean;
  authOk: boolean;
  hasSharedAuth: boolean;
  isLocalClient: boolean;
}): MissingDeviceIdentityDecision {
  if (params.hasDeviceIdentity) {
    return { kind: "allow" };
  }
  if (params.isControlUi && params.trustedProxyAuthOk) {
    return { kind: "allow" };
  }
  if (params.isControlUi && params.controlUiAuthPolicy.allowBypass && params.role === "operator") {
    // dangerouslyDisableDeviceAuth: true — operator has explicitly opted out of
    // device-identity enforcement for this Control UI.  Allow for operator-role
    // sessions only; node-role sessions must still satisfy device identity so
    // that the break-glass flag cannot be abused to admit device-less node
    // registrations (see #45405 review).
    return { kind: "allow" };
  }
  if (params.localBackendSelfPairingOk && params.role === "operator") {
    return { kind: "allow" };
  }
  if (params.isControlUi && !params.controlUiAuthPolicy.allowBypass) {
    // Allow localhost Control UI connections when allowInsecureAuth is configured.
    // Localhost has no network interception risk, and browser SubtleCrypto
    // (needed for device identity) is unavailable in insecure HTTP contexts.
    // Remote connections are still rejected to preserve the MitM protection
    // that the security fix (#20684) intended.
    if (!params.controlUiAuthPolicy.allowInsecureAuthConfigured || !params.isLocalClient) {
      return { kind: "reject-control-ui-insecure-auth" };
    }
  }
  if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) {
    return { kind: "allow" };
  }
  if (!params.authOk && params.hasSharedAuth) {
    return { kind: "reject-unauthorized" };
  }
  return { kind: "reject-device-required" };
}
