// Gateway WebSocket device proof binds the signed identity to the connect request.
import { resolveDeviceAuthConnectErrorDetailCode } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, errorShape } from "../../../../packages/gateway-protocol/src/index.js";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
} from "../../../infra/device-identity.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import type { GatewayRole } from "../../role-policy.js";
import { emitGatewayAuthSecurityEvent } from "./connect-auth-security.js";
import { resolveDeviceSignaturePayloadVersion } from "./handshake-auth-helpers.js";
import type { GatewayConnectPhaseContext } from "./message-handler-types.js";

const DEVICE_SIGNATURE_SKEW_MS = 2 * 60 * 1000;

export function verifyGatewayConnectDeviceProof(
  context: GatewayConnectPhaseContext,
  params: {
    device: GatewayConnectPhaseContext["connectParams"]["device"] | null | undefined;
    resolvedAuth: ResolvedGatewayAuth;
    authMethod: GatewayAuthResult["method"];
    role: GatewayRole;
    scopes: string[];
  },
):
  | { ok: true; devicePublicKey: string | null; deviceAuthPayloadVersion: "v2" | "v3" | null }
  | { ok: false } {
  const { device, resolvedAuth, authMethod, role, scopes } = params;
  if (!device) {
    return { ok: true, devicePublicKey: null, deviceAuthPayloadVersion: null };
  }
  const { frame, connectParams } = context;
  const { send, close, setHandshakeState, setCloseCause } = context.handler;
  const rejectDeviceAuthInvalid = (reason: string, message: string) => {
    emitGatewayAuthSecurityEvent({
      action: "gateway.auth.failed",
      outcome: "denied",
      severity: "medium",
      authMode: resolvedAuth.mode,
      authMethod,
      authProvided: "device-signature",
      role,
      scopes,
      clientMode: connectParams.client.mode,
      deviceId: device.id,
      reason,
    });
    setHandshakeState("failed");
    setCloseCause("device-auth-invalid", {
      reason,
      client: connectParams.client.id,
      deviceId: device.id,
    });
    send({
      type: "res",
      id: frame.id,
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, message, {
        details: { code: resolveDeviceAuthConnectErrorDetailCode(reason), reason },
      }),
    });
    close(1008, message);
  };
  const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
  if (!derivedId || derivedId !== device.id) {
    rejectDeviceAuthInvalid("device-id-mismatch", "device identity mismatch");
    return { ok: false };
  }
  const signedAt = device.signedAt;
  if (typeof signedAt !== "number" || Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS) {
    rejectDeviceAuthInvalid("device-signature-stale", "device signature expired");
    return { ok: false };
  }
  const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
  if (!providedNonce) {
    rejectDeviceAuthInvalid("device-nonce-missing", "device nonce required");
    return { ok: false };
  }
  if (providedNonce !== context.handler.connectNonce) {
    rejectDeviceAuthInvalid("device-nonce-mismatch", "device nonce mismatch");
    return { ok: false };
  }
  const payloadVersion = resolveDeviceSignaturePayloadVersion({
    device,
    connectParams,
    role,
    scopes,
    signedAtMs: signedAt,
    nonce: providedNonce,
  });
  if (!payloadVersion) {
    rejectDeviceAuthInvalid("device-signature", "device signature invalid");
    return { ok: false };
  }
  const devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
  if (!devicePublicKey) {
    rejectDeviceAuthInvalid("device-public-key", "device public key invalid");
    return { ok: false };
  }
  return { ok: true, devicePublicKey, deviceAuthPayloadVersion: payloadVersion };
}
