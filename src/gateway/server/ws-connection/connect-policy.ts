// WebSocket connect policy resolves Control UI pairing bypasses and missing-device identity decisions.
import type { ConnectParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayRole } from "../../role-policy.js";
import { roleCanSkipDeviceIdentity } from "../../role-policy.js";

export type ControlUiPairingKind = "tailscale-device" | "auth-none" | null;

export function shouldSkipControlUiPairing(params: {
  isControlUi: boolean;
  device: ConnectParams["device"] | null | undefined;
  role: GatewayRole;
  authMode?: string;
  authMethod?: string;
}): ControlUiPairingKind {
  if (
    params.isControlUi &&
    params.role === "operator" &&
    params.authMethod === "tailscale" &&
    params.device
  ) {
    return "tailscale-device";
  }
  // When auth is completely disabled (mode=none), there is no shared secret
  // or token to gate pairing. Requiring pairing in this configuration adds
  // friction without security value since any client can already connect
  // without credentials. Guard with isControlUi because this function is
  // called for ALL clients (not just Control UI) at the call site.
  // Scope to operator role so node-role sessions still need device identity
  // (#43478 was reverted for skipping ALL clients).
  if (params.isControlUi && params.role === "operator" && params.authMode === "none") {
    return "auth-none";
  }
  return null;
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

type MissingDeviceIdentityDecision =
  | { kind: "allow" }
  | { kind: "reject-control-ui-insecure-auth" }
  | { kind: "reject-unauthorized" }
  | { kind: "reject-device-required" };

export function shouldClearUnboundScopesForMissingDeviceIdentity(params: {
  decision: MissingDeviceIdentityDecision;
  authMethod: string | undefined;
}): boolean {
  return (
    params.decision.kind !== "allow" ||
    params.authMethod === "token" ||
    params.authMethod === "password" ||
    params.authMethod === "trusted-proxy"
  );
}

export function evaluateMissingDeviceIdentity(params: {
  hasDeviceIdentity: boolean;
  role: GatewayRole;
  isControlUi: boolean;
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
  if (params.localBackendSelfPairingOk && params.role === "operator") {
    return { kind: "allow" };
  }
  if (params.isControlUi) {
    return { kind: "reject-control-ui-insecure-auth" };
  }
  if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) {
    return { kind: "allow" };
  }
  if (!params.authOk && params.hasSharedAuth) {
    return { kind: "reject-unauthorized" };
  }
  return { kind: "reject-device-required" };
}
