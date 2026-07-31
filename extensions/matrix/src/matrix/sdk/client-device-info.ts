import type { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import type {
  MatrixOwnCrossSigningPublicationStatus,
  MatrixOwnDeviceInfo,
} from "./client-support.js";

export async function resolveMatrixCrossSigningPublicationStatus(params: {
  userId: string | null;
  query: () => Promise<{
    master_keys?: Record<string, unknown>;
    self_signing_keys?: Record<string, unknown>;
    user_signing_keys?: Record<string, unknown>;
  }>;
}): Promise<MatrixOwnCrossSigningPublicationStatus> {
  if (!params.userId) {
    return {
      userId: null,
      masterKeyPublished: false,
      selfSigningKeyPublished: false,
      userSigningKeyPublished: false,
      published: false,
    };
  }

  try {
    const response = await params.query();
    const masterKeyPublished = Boolean(response.master_keys?.[params.userId]);
    const selfSigningKeyPublished = Boolean(response.self_signing_keys?.[params.userId]);
    const userSigningKeyPublished = Boolean(response.user_signing_keys?.[params.userId]);
    return {
      userId: params.userId,
      masterKeyPublished,
      selfSigningKeyPublished,
      userSigningKeyPublished,
      published: masterKeyPublished && selfSigningKeyPublished && userSigningKeyPublished,
    };
  } catch {
    return {
      userId: params.userId,
      masterKeyPublished: false,
      selfSigningKeyPublished: false,
      userSigningKeyPublished: false,
      published: false,
    };
  }
}

export async function listMatrixOwnDevices(client: MatrixJsClient): Promise<MatrixOwnDeviceInfo[]> {
  const currentDeviceId = client.getDeviceId()?.trim() || null;
  const devices = await client.getDevices();
  const entries = Array.isArray(devices?.devices) ? devices.devices : [];
  return entries.map((device) => ({
    deviceId: device.device_id,
    displayName: device.display_name?.trim() || null,
    lastSeenIp: device.last_seen_ip?.trim() || null,
    lastSeenTs:
      typeof device.last_seen_ts === "number" && Number.isFinite(device.last_seen_ts)
        ? device.last_seen_ts
        : null,
    current: currentDeviceId !== null && device.device_id === currentDeviceId,
  }));
}
