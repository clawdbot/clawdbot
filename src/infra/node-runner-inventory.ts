import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  type WorkerAdmissionHandshake,
  validateWorkerAdmissionHandshake,
} from "../../packages/gateway-protocol/src/index.js";

export const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v1";

type NodeWorkerSupervisorProtocolFeatures =
  | readonly []
  | readonly [typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE];

export type NodeRunnerInventoryDeclaration = {
  protocolFeatures: NodeWorkerSupervisorProtocolFeatures;
  workerRuns?: WorkerAdmissionHandshake;
};

/** Parses the closed reconnect-scoped node-host runner declaration. */
export function parseNodeRunnerInventoryDeclaration(
  value: unknown,
): NodeRunnerInventoryDeclaration | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    !Object.hasOwn(value, "protocolFeatures") ||
    keys.some((key) => key !== "protocolFeatures" && key !== "workerRuns") ||
    !Array.isArray(value.protocolFeatures) ||
    value.protocolFeatures.length > 1
  ) {
    return null;
  }
  let protocolFeatures: NodeWorkerSupervisorProtocolFeatures;
  if (value.protocolFeatures.length === 0) {
    protocolFeatures = [];
  } else if (value.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE) {
    protocolFeatures = [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE];
  } else {
    return null;
  }
  const workerRuns = value.workerRuns;
  if (workerRuns !== undefined) {
    if (protocolFeatures.length === 0 || !validateWorkerAdmissionHandshake(workerRuns)) {
      return null;
    }
    return { protocolFeatures, workerRuns: structuredClone(workerRuns) };
  }
  return { protocolFeatures };
}
