import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { storeDeviceAuthToken } from "../infra/device-auth-store.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { resolveGatewayClientPlatformIdentity } from "../shared/gateway-client-platform.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";

type StartupLocalCliPairingResult = "created" | "reused" | "unavailable";

function cacheOperatorToken(params: {
  deviceId: string;
  paired: Awaited<ReturnType<typeof getPairedDevice>>;
}): boolean {
  const token = params.paired?.tokens?.operator;
  if (
    !token?.token ||
    !roleScopesAllow({
      role: "operator",
      requestedScopes: [ADMIN_SCOPE],
      allowedScopes: token.scopes,
    })
  ) {
    return false;
  }
  storeDeviceAuthToken({
    deviceId: params.deviceId,
    role: "operator",
    token: token.token,
    scopes: token.scopes,
  });
  return true;
}

/**
 * Runtime-only auth has no shared secret a sibling CLI process can read. Bind
 * the canonical same-user device identity before readiness instead, preserving
 * authenticated loopback access without writing generated auth into config.
 */
export async function ensureStartupLocalCliPairing(): Promise<StartupLocalCliPairingResult> {
  const identity = loadOrCreateDeviceIdentity();
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const existing = await getPairedDevice(identity.deviceId);
  if (existing) {
    if (existing.publicKey !== publicKey) {
      throw new Error("local CLI pairing identity does not match the canonical device key");
    }
    return cacheOperatorToken({ deviceId: identity.deviceId, paired: existing })
      ? "reused"
      : "unavailable";
  }

  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    displayName: "OpenClaw CLI",
    ...resolveGatewayClientPlatformIdentity(process.platform),
    clientId: GATEWAY_CLIENT_NAMES.CLI,
    clientMode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    scopes: [ADMIN_SCOPE],
    remoteIp: "127.0.0.1",
    silent: true,
  });
  const approved = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: [ADMIN_SCOPE],
    approvedVia: "silent",
    accessMetadata: {
      displayName: "OpenClaw CLI",
      remoteIp: "127.0.0.1",
      lastSeenAtMs: Date.now(),
      lastSeenReason: "runtime-token-startup",
    },
  });
  if (approved?.status === "approved") {
    if (!cacheOperatorToken({ deviceId: identity.deviceId, paired: approved.device })) {
      throw new Error("local CLI pairing approval did not issue an operator token");
    }
    return "created";
  }

  // A concurrent startup can win the pairing transaction. Re-read the
  // authoritative row instead of rotating or duplicating its token.
  const pairedAfterApproval = await getPairedDevice(identity.deviceId);
  if (
    pairedAfterApproval?.publicKey === publicKey &&
    cacheOperatorToken({ deviceId: identity.deviceId, paired: pairedAfterApproval })
  ) {
    return "reused";
  }
  return "unavailable";
}
