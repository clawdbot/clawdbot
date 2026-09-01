import { loadDeviceBootstrapState, withDeviceBootstrapLock } from "./device-bootstrap-state.js";
import { persistDeviceBootstrapTokenRecords as persistState } from "./device-pairing-store.js";
import { verifyPairingToken } from "./pairing-token.js";

const MAX_PENDING_APPROVAL_REQUESTS = 16;

/** Remember the exact owner prompt created by an observable bootstrap connection. */
export async function registerDeviceBootstrapApprovalRequest(params: {
  token: string;
  requestId: string;
  role: string;
  scopes: readonly string[];
  baseDir?: string;
}): Promise<boolean> {
  return await withDeviceBootstrapLock(async () => {
    const token = params.token.trim();
    const requestId = params.requestId.trim();
    const role = params.role.trim();
    if (!token || !requestId || !role) {
      return false;
    }
    const state = await loadDeviceBootstrapState(params.baseDir);
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(token, candidate.token),
    );
    if (!found) {
      return false;
    }
    const [tokenKey, record] = found;
    const requests = [
      ...(record.pendingApprovalRequests ?? []).filter(
        (candidate) => candidate.requestId !== requestId,
      ),
      { requestId, role, scopes: [...params.scopes] },
    ].slice(-MAX_PENDING_APPROVAL_REQUESTS);
    state[tokenKey] = { ...record, pendingApprovalRequests: requests };
    persistState(state, params.baseDir);
    return true;
  });
}

/** Forget an approval prompt that was rejected or replaced. */
export async function clearDeviceBootstrapApprovalRequest(
  requestId: string,
  baseDir?: string,
): Promise<void> {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) {
    return;
  }
  await withDeviceBootstrapLock(async () => {
    const state = await loadDeviceBootstrapState(baseDir);
    let changed = false;
    for (const [tokenKey, record] of Object.entries(state)) {
      const requests = (record.pendingApprovalRequests ?? []).filter(
        (candidate) => candidate.requestId !== normalizedRequestId,
      );
      if (requests.length === (record.pendingApprovalRequests?.length ?? 0)) {
        continue;
      }
      const nextRecord = { ...record };
      if (requests.length > 0) {
        nextRecord.pendingApprovalRequests = requests;
      } else {
        delete nextRecord.pendingApprovalRequests;
      }
      state[tokenKey] = nextRecord;
      changed = true;
    }
    if (changed) {
      persistState(state, baseDir);
    }
  });
}
