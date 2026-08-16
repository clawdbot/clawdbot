import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  type WorkerAdmissionHandshake,
  validateWorkerAdmissionHandshake,
} from "../../packages/gateway-protocol/src/index.js";

export const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v2";
export const NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE = "node-worker-supervisor-v1";

export const NODE_RUNNER_UPDATE_REQUIRED_ISSUE = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

export type NodeRunnerInventoryIssue = typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE;

type NodeWorkerSupervisorProtocolFeatures =
  | readonly []
  | readonly [typeof NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE]
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
  } else if (
    value.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE ||
    value.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE
  ) {
    protocolFeatures = [value.protocolFeatures[0]];
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

export function formatNodeRunnerUpdateRequired(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): string {
  return `device worker node ${nodeId} requires an update before it can host sessions; run ${issue.updateCommand}, then reconnect it (for a headless node, run ${issue.headlessReconnectCommand})`;
}
