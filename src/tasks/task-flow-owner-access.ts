// Checks whether a requester can read or mutate task-flow records.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  findLatestActionableTaskFlowForOwnerKey,
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

/**
 * Resolves the owner-key lookup for `show`/`cancel` to the newest non-terminal
 * flow the caller owns, falling back to the newest flow overall when every
 * flow is terminal. Mirrors `findLatestActionableTaskFlowForOwnerKey` under
 * the caller-owner scope.
 */
export function findLatestActionableTaskFlowForOwner(params: {
  callerOwnerKey: string;
}): TaskFlowRecord | undefined {
  const ownerKey = normalizeOptionalString(params.callerOwnerKey);
  return ownerKey ? findLatestActionableTaskFlowForOwnerKey(ownerKey) : undefined;
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
  return findLatestActionableTaskFlowForOwner({ callerOwnerKey: normalizedCallerOwnerKey });
}
