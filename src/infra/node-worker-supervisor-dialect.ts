import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const NODE_PROTOCOL_FEATURES_UPDATE_METHOD = "node.protocolFeatures.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v1";

type NodeWorkerSupervisorProtocolFeatures =
  | readonly []
  | readonly [typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE];

/** Parses the closed reconnect-scoped node-host supervisor dialect publication. */
export function parseNodeWorkerSupervisorProtocolFeatures(
  value: unknown,
): NodeWorkerSupervisorProtocolFeatures | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "protocolFeatures") ||
    !Array.isArray(value.protocolFeatures) ||
    value.protocolFeatures.length > 1
  ) {
    return null;
  }
  if (value.protocolFeatures.length === 0) {
    return [];
  }
  return value.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE
    ? [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE]
    : null;
}
