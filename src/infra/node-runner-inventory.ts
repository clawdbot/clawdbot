import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateWorkerAdmissionHandshake } from "../../packages/gateway-protocol/src/index.js";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";

export const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v6";
const NODE_WORKER_SUPERVISOR_EXACT_CAPACITY_PROTOCOL_FEATURE = "node-worker-supervisor-v5";
const NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE = "node-worker-supervisor-v4";
const NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE = "node-worker-supervisor-v3";
const NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE = "node-worker-supervisor-v2";
const NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE = "node-worker-supervisor-v1";
export const NODE_WORKER_BUNDLE_RETENTION_VERSION = 1;
export const NODE_WORKER_BUNDLE_STATUS_VERSION = 1;
export const NODE_WORKER_CAPACITY_MAX = 1_024;

export const NODE_RUNNER_UPDATE_REQUIRED_ISSUE = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

export type NodeRunnerInventoryIssue = typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE;
export type NodeWorkerCapacitySnapshot = Readonly<{
  total: number;
  available: number;
}>;

export type NodeWorkerHostDeclaration =
  | { enabled: false }
  | {
      enabled: true;
      capacity: NodeWorkerCapacitySnapshot;
      bundlePrewarm?: typeof WORKER_BUNDLE_PREWARM_VERSION;
      bundleRetention?: typeof NODE_WORKER_BUNDLE_RETENTION_VERSION;
      bundleStatus?: typeof NODE_WORKER_BUNDLE_STATUS_VERSION;
    };

export type NodeRunnerInventoryDeclaration =
  | { protocolFeatures: readonly [] }
  | {
      protocolFeatures: readonly [
        | typeof NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_EXACT_CAPACITY_PROTOCOL_FEATURE,
      ];
    }
  | {
      protocolFeatures: readonly [typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE];
      workerHost: NodeWorkerHostDeclaration;
    };

function parseCapacitySnapshot(value: unknown): NodeWorkerCapacitySnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const total = value.total;
  const available = value.available;
  return keys.length === 2 &&
    keys.includes("total") &&
    keys.includes("available") &&
    typeof total === "number" &&
    typeof available === "number" &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(available) &&
    total >= 1 &&
    total <= NODE_WORKER_CAPACITY_MAX &&
    available >= 0 &&
    available <= total
    ? { total, available }
    : null;
}

function parseWorkerHostDeclaration(value: unknown): NodeWorkerHostDeclaration | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return null;
  }
  const keys = Object.keys(value);
  if (!value.enabled) {
    return keys.length === 1 && keys[0] === "enabled" ? { enabled: false } : null;
  }
  const capacity = parseCapacitySnapshot(value.capacity);
  if (
    !capacity ||
    keys.length < 2 ||
    keys.length > 5 ||
    !keys.includes("enabled") ||
    !keys.includes("capacity") ||
    keys.some(
      (key) =>
        key !== "enabled" &&
        key !== "capacity" &&
        key !== "bundlePrewarm" &&
        key !== "bundleRetention" &&
        key !== "bundleStatus",
    ) ||
    (value.bundlePrewarm !== undefined && value.bundlePrewarm !== WORKER_BUNDLE_PREWARM_VERSION) ||
    (value.bundleRetention !== undefined &&
      value.bundleRetention !== NODE_WORKER_BUNDLE_RETENTION_VERSION) ||
    (value.bundleStatus !== undefined &&
      value.bundleStatus !== NODE_WORKER_BUNDLE_STATUS_VERSION) ||
    (value.bundleStatus !== undefined && value.bundleRetention === undefined)
  ) {
    return null;
  }
  return {
    enabled: true,
    capacity,
    ...(value.bundlePrewarm === WORKER_BUNDLE_PREWARM_VERSION
      ? { bundlePrewarm: WORKER_BUNDLE_PREWARM_VERSION }
      : {}),
    ...(value.bundleRetention === NODE_WORKER_BUNDLE_RETENTION_VERSION
      ? { bundleRetention: NODE_WORKER_BUNDLE_RETENTION_VERSION }
      : {}),
    ...(value.bundleStatus === NODE_WORKER_BUNDLE_STATUS_VERSION
      ? { bundleStatus: NODE_WORKER_BUNDLE_STATUS_VERSION }
      : {}),
  };
}

function isBinaryCapacityWorkerHostDeclaration(value: unknown): boolean {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return false;
  }
  const keys = Object.keys(value);
  if (!value.enabled) {
    return keys.length === 1 && keys[0] === "enabled";
  }
  return (
    keys.length >= 2 &&
    keys.length <= 5 &&
    keys.includes("enabled") &&
    keys.includes("capacity") &&
    keys.every(
      (key) =>
        key === "enabled" ||
        key === "capacity" ||
        key === "bundlePrewarm" ||
        key === "bundleRetention" ||
        key === "bundleStatus",
    ) &&
    (value.capacity === "available" || value.capacity === "full") &&
    (value.bundlePrewarm === undefined || value.bundlePrewarm === WORKER_BUNDLE_PREWARM_VERSION) &&
    (value.bundleRetention === undefined ||
      value.bundleRetention === NODE_WORKER_BUNDLE_RETENTION_VERSION) &&
    (value.bundleStatus === undefined ||
      value.bundleStatus === NODE_WORKER_BUNDLE_STATUS_VERSION) &&
    (value.bundleStatus === undefined || value.bundleRetention !== undefined)
  );
}

/** Parses the closed reconnect-scoped node-host runner declaration. */
export function parseNodeRunnerInventoryDeclaration(
  value: unknown,
): NodeRunnerInventoryDeclaration | null {
  if (!isRecord(value) || !Array.isArray(value.protocolFeatures)) {
    return null;
  }
  const keys = Object.keys(value);
  if (value.protocolFeatures.length === 0) {
    return keys.length === 1 && keys.includes("protocolFeatures") ? { protocolFeatures: [] } : null;
  }
  if (value.protocolFeatures.length !== 1) {
    return null;
  }
  const feature = value.protocolFeatures[0];
  if (
    feature === NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE ||
    feature === NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE
  ) {
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      keys.some((key) => key !== "protocolFeatures" && key !== "workerRuns") ||
      (value.workerRuns !== undefined && !validateWorkerAdmissionHandshake(value.workerRuns))
    ) {
      return null;
    }
    // v1/v2 carried the node-local package build in inventory. Keep wire
    // validation only so shipped nodes receive the explicit update path.
    return { protocolFeatures: [feature] };
  }
  if (
    feature === NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE ||
    feature === NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE
  ) {
    return keys.length === 2 && isBinaryCapacityWorkerHostDeclaration(value.workerHost)
      ? { protocolFeatures: [feature] }
      : null;
  }
  if (feature === NODE_WORKER_SUPERVISOR_EXACT_CAPACITY_PROTOCOL_FEATURE) {
    return keys.length === 2 && parseWorkerHostDeclaration(value.workerHost)
      ? { protocolFeatures: [feature] }
      : null;
  }
  if (feature !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE || keys.length !== 2) {
    return null;
  }
  const workerHost = parseWorkerHostDeclaration(value.workerHost);
  return workerHost
    ? { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost }
    : null;
}

export function formatNodeRunnerUpdateRequired(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): string {
  return `device worker node ${nodeId} requires an update before it can host sessions; run ${issue.updateCommand}, then reconnect it (for a headless node, run ${issue.headlessReconnectCommand})`;
}
