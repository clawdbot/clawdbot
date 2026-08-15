// Checks whether a requester can read or mutate task-flow records.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  findLatestTaskFlowForOwnerKey,
  getTaskFlowById,
  listTaskFlowsForOwnerKey,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

/** Reads a flow only when it belongs to the caller owner key. */
export function getTaskFlowByIdForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
}): TaskFlowRecord | undefined {
  const flow = getTaskFlowById(params.flowId);
  return flow &&
    normalizeOptionalString(flow.ownerKey) === normalizeOptionalString(params.callerOwnerKey)
    ? flow
    : undefined;
}

export function listTaskFlowsForOwner(params: { callerOwnerKey: string }): TaskFlowRecord[] {
  const ownerKey = normalizeOptionalString(params.callerOwnerKey);
  return ownerKey ? listTaskFlowsForOwnerKey(ownerKey) : [];
}

export function findLatestTaskFlowForOwner(params: {
  callerOwnerKey: string;
}): TaskFlowRecord | undefined {
  const ownerKey = normalizeOptionalString(params.callerOwnerKey);
  return ownerKey ? findLatestTaskFlowForOwnerKey(ownerKey) : undefined;
}

export function resolveTaskFlowForLookupTokenForOwner(params: {
  token: string;
  callerOwnerKey: string;
}): TaskFlowRecord | undefined {
  const direct = getTaskFlowByIdForOwner({
    flowId: params.token,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (direct) {
    return direct;
  }
  const normalizedToken = normalizeOptionalString(params.token);
  const normalizedCallerOwnerKey = normalizeOptionalString(params.callerOwnerKey);
  if (!normalizedToken || normalizedToken !== normalizedCallerOwnerKey) {
    return undefined;
  }
  return findLatestTaskFlowForOwner({ callerOwnerKey: normalizedCallerOwnerKey });
}
