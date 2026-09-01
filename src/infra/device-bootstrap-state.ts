import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { loadDeviceBootstrapTokenRecords } from "./device-pairing-store.js";
import type { DeviceBootstrapTokenRecord } from "./device-pairing.types.js";
import { createAsyncLock, pruneExpiredPending } from "./pairing-files.js";
import { verifyPairingToken } from "./pairing-token.js";

export const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_APPROVAL_REQUESTS = 16;
export type DeviceBootstrapState = Record<string, DeviceBootstrapTokenRecord>;
export const withDeviceBootstrapLock = createAsyncLock();

export async function loadDeviceBootstrapState(baseDir?: string): Promise<DeviceBootstrapState> {
  const state = loadDeviceBootstrapTokenRecords(baseDir);
  pruneExpiredPending(state, asDateTimestampMs(Date.now()) ?? 0, DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  return state;
}

export function findDeviceBootstrapTokenRecord(
  state: DeviceBootstrapState,
  token: string,
): [string, DeviceBootstrapTokenRecord] | undefined {
  return Object.entries(state).find(([, candidate]) => verifyPairingToken(token, candidate.token));
}

export function withoutDeviceBootstrapApprovalRequest(
  record: DeviceBootstrapTokenRecord,
  requestId: string,
): DeviceBootstrapTokenRecord {
  const pendingApprovalRequests = (record.pendingApprovalRequests ?? []).filter(
    (candidate) => candidate.requestId !== requestId,
  );
  if (pendingApprovalRequests.length === (record.pendingApprovalRequests?.length ?? 0)) {
    return record;
  }
  const nextRecord = { ...record };
  if (pendingApprovalRequests.length > 0) {
    nextRecord.pendingApprovalRequests = pendingApprovalRequests;
  } else {
    delete nextRecord.pendingApprovalRequests;
  }
  return nextRecord;
}

/** Link an observable bootstrap credential to its exact owner prompt. */
export function linkDeviceBootstrapApprovalRequestInState(params: {
  state: DeviceBootstrapState;
  token: string;
  requestId: string;
  role: string;
  scopes: readonly string[];
  supersededRequestIds?: readonly string[];
}): boolean {
  const token = params.token.trim();
  const requestId = params.requestId.trim();
  const role = params.role.trim();
  if (!token || !requestId || !role) {
    return false;
  }
  const found = findDeviceBootstrapTokenRecord(params.state, token);
  if (!found) {
    return false;
  }
  const requestIds = new Set([requestId, ...(params.supersededRequestIds ?? [])]);
  for (const [candidateKey, candidate] of Object.entries(params.state)) {
    let nextCandidate = candidate;
    for (const candidateRequestId of requestIds) {
      nextCandidate = withoutDeviceBootstrapApprovalRequest(nextCandidate, candidateRequestId);
    }
    params.state[candidateKey] = nextCandidate;
  }
  const [tokenKey, foundRecord] = found;
  const record = params.state[tokenKey] ?? foundRecord;
  const requests = [
    ...(record.pendingApprovalRequests ?? []),
    { requestId, role, scopes: [...params.scopes] },
  ].slice(-MAX_PENDING_APPROVAL_REQUESTS);
  params.state[tokenKey] = { ...record, pendingApprovalRequests: requests };
  return true;
}

export function removeDeviceBootstrapApprovalRequestInState(params: {
  state: DeviceBootstrapState;
  requestId: string;
  revokeToken: boolean;
}): boolean {
  let changed = false;
  for (const [tokenKey, record] of Object.entries(params.state)) {
    const nextRecord = withoutDeviceBootstrapApprovalRequest(record, params.requestId);
    if (nextRecord === record) {
      continue;
    }
    changed = true;
    if (params.revokeToken) {
      delete params.state[tokenKey];
    } else {
      params.state[tokenKey] = nextRecord;
    }
  }
  return changed;
}
