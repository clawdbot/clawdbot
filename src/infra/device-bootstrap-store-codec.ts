import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeDeviceBootstrapProfile,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import type { DeviceBootstrapTokens } from "../state/openclaw-state-db.generated.js";
import type { DeviceBootstrapTokenRecord } from "./device-pairing.types.js";

export const DEVICE_BOOTSTRAP_TOKEN_COLUMNS_WITHOUT_SETUP = [
  "device_id",
  "issued_at_ms",
  "last_used_at_ms",
  "pending_profile_json",
  "profile_json",
  "public_key",
  "redeemed_profile_json",
  "token",
  "token_key",
  "ts",
] as const satisfies readonly (keyof DeviceBootstrapTokens)[];

type PersistedPendingBootstrapState = Partial<DeviceBootstrapProfile> & {
  approvalRequests?: unknown;
};

export function encodePendingBootstrapState(
  record: DeviceBootstrapTokenRecord,
): PersistedPendingBootstrapState | undefined {
  if (!record.pendingProfile && !record.pendingApprovalRequests?.length) {
    return undefined;
  }
  return {
    ...record.pendingProfile,
    ...(record.pendingApprovalRequests?.length
      ? { approvalRequests: record.pendingApprovalRequests }
      : {}),
  };
}

export function decodePendingBootstrapState(value: unknown): {
  pendingProfile?: DeviceBootstrapProfile;
  pendingApprovalRequests?: DeviceBootstrapTokenRecord["pendingApprovalRequests"];
} {
  if (!value || typeof value !== "object") {
    return {};
  }
  const pendingState = asRecord(value);
  const requests = Array.isArray(pendingState.approvalRequests)
    ? pendingState.approvalRequests.flatMap((request) => {
        if (!request || typeof request !== "object") {
          return [];
        }
        const candidate = asRecord(request);
        const requestId = typeof candidate.requestId === "string" ? candidate.requestId.trim() : "";
        const role = typeof candidate.role === "string" ? candidate.role.trim() : "";
        const scopes = Array.isArray(candidate.scopes)
          ? candidate.scopes.filter((scope): scope is string => typeof scope === "string")
          : [];
        return requestId && role ? [{ requestId, role, scopes }] : [];
      })
    : [];
  const hasProfile =
    "roles" in pendingState || "scopes" in pendingState || "purpose" in pendingState;
  return {
    ...(hasProfile ? { pendingProfile: normalizeDeviceBootstrapProfile(pendingState) } : {}),
    ...(requests.length > 0 ? { pendingApprovalRequests: requests } : {}),
  };
}
