// Checks whether a requester can read or mutate task-flow records.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../routing/session-key.js";
import { getTaskFlowById, listTaskFlowsForOwnerKey } from "./task-flow-registry.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";
import { resolveTaskSessionAgentId } from "./task-session-identity.js";

type TaskFlowOwnerIdentity = {
  callerOwnerKey: string;
  callerAgentId?: string;
};

function canOwnerAccessTaskFlow(flow: TaskFlowRecord, identity: TaskFlowOwnerIdentity): boolean {
  if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(identity.callerOwnerKey)) {
    return false;
  }
  const callerAgentId = resolveTaskSessionAgentId(identity.callerOwnerKey, identity.callerAgentId);
  // A bare owner key can be shared by multiple agent stores. Legacy rows without
  // a persisted agent identity stay inaccessible until explicitly migrated.
  if (!callerAgentId) {
    return false;
  }
  const flowAgentId = resolveTaskSessionAgentId(flow.ownerKey, flow.agentId);
  return Boolean(flowAgentId) && normalizeAgentId(flowAgentId) === normalizeAgentId(callerAgentId);
}

/** Reads a flow only when it belongs to the caller owner key. */
export function getTaskFlowByIdForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
  callerAgentId?: string;
}): TaskFlowRecord | undefined {
  const flow = getTaskFlowById(params.flowId);
  return flow && canOwnerAccessTaskFlow(flow, params) ? flow : undefined;
}

export function listTaskFlowsForOwner(params: {
  callerOwnerKey: string;
  callerAgentId?: string;
}): TaskFlowRecord[] {
  const ownerKey = normalizeOptionalString(params.callerOwnerKey);
  return ownerKey
    ? listTaskFlowsForOwnerKey(ownerKey).filter((flow) => canOwnerAccessTaskFlow(flow, params))
    : [];
}

export function findLatestTaskFlowForOwner(params: {
  callerOwnerKey: string;
  callerAgentId?: string;
}): TaskFlowRecord | undefined {
  return listTaskFlowsForOwner(params)[0];
}

export function resolveTaskFlowForLookupTokenForOwner(params: {
  token: string;
  callerOwnerKey: string;
  callerAgentId?: string;
}): TaskFlowRecord | undefined {
  const direct = getTaskFlowByIdForOwner({
    flowId: params.token,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
  });
  if (direct) {
    return direct;
  }
  const normalizedToken = normalizeOptionalString(params.token);
  const normalizedCallerOwnerKey = normalizeOptionalString(params.callerOwnerKey);
  if (!normalizedToken || normalizedToken !== normalizedCallerOwnerKey) {
    return undefined;
  }
  const ownerFlows = listTaskFlowsForOwner({
    callerOwnerKey: normalizedCallerOwnerKey,
    callerAgentId: params.callerAgentId,
  });
  return ownerFlows.find((flow) => !isTerminalTaskFlow(flow)) ?? ownerFlows[0];
}
