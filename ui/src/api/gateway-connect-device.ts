import { buildDeviceAuthPayload, type ConnectParams } from "@openclaw/gateway-client/browser";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "../lib/nodes/index.ts";

export async function buildGatewayConnectDevice(params: {
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  client: ConnectParams["client"];
  role: string;
  scopes: string[];
  authToken?: string;
  connectNonce: string | null;
  connectChallengeTs: number | null | undefined;
}): Promise<NonNullable<ConnectParams["device"]> | undefined> {
  const { deviceIdentity } = params;
  if (!deviceIdentity) {
    return undefined;
  }
  if (params.connectChallengeTs === null) {
    throw new Error("gateway connect challenge timestamp invalid");
  }
  // The Control UI alone supports pre-challenge Gateways; that timeout fallback has no server time.
  const signedAtMs = params.connectChallengeTs ?? Date.now();
  const nonce = params.connectNonce ?? "";
  const payload = buildDeviceAuthPayload({
    deviceId: deviceIdentity.deviceId,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: params.authToken ?? null,
    nonce,
  });
  const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
  return {
    id: deviceIdentity.deviceId,
    publicKey: deviceIdentity.publicKey,
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}
