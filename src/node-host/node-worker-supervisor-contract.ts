import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerSupervisorIdentity } from "./node-worker-supervisor-identity.js";

export type { NodeWorkerSupervisorIdentity } from "./node-worker-supervisor-identity.js";

const IDENTIFIER_MAX_CHARS = 256;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NODE_WORKER_SUPERVISOR_CANCEL_REQUEST_MAX_BYTES = 4 * 1024;

export type NodeWorkerLaunchInput = {
  launchId: string;
  gatewayNamespace: string;
  bundleHash: string;
  placementGeneration: number;
  descriptor: WorkerLaunchDescriptor;
};

export type NodeWorkerSupervisorReceipt = NodeWorkerSupervisorIdentity & {
  state: "pending" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
};

export type NodeWorkerSupervisorControl = {
  launch(input: NodeWorkerLaunchInput): Promise<NodeWorkerLaunchReceipt>;
  status(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined>;
  cancel(expected: NodeWorkerSupervisorIdentity): Promise<NodeWorkerLaunchReceipt | undefined>;
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_MAX_CHARS ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    throw new Error(`INVALID_REQUEST: ${label} must be a bounded non-empty identifier`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`INVALID_REQUEST: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function decodeRequest(raw?: string | null): unknown {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

export function parseNodeWorkerLaunchInput(raw?: string | null): NodeWorkerLaunchInput {
  const value = decodeRequest(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "launchId",
      "gatewayNamespace",
      "bundleHash",
      "placementGeneration",
      "descriptor",
    ])
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker launch request");
  }
  const launchId = requireIdentifier(value.launchId, "launchId");
  const gatewayNamespace = requireIdentifier(value.gatewayNamespace, "gatewayNamespace");
  if (!GATEWAY_NAMESPACE_PATTERN.test(gatewayNamespace)) {
    throw new Error("INVALID_REQUEST: gatewayNamespace must be a safe bounded path component");
  }
  if (typeof value.bundleHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.bundleHash)) {
    throw new Error("INVALID_REQUEST: bundleHash must be 64 lowercase hexadecimal characters");
  }
  let descriptor: WorkerLaunchDescriptor;
  try {
    descriptor = parseWorkerLaunchDescriptor(value.descriptor);
  } catch {
    throw new Error("INVALID_REQUEST: invalid worker launch descriptor");
  }
  if (descriptor.admission.handshake.bundleHash !== value.bundleHash) {
    throw new Error("INVALID_REQUEST: descriptor bundle hash does not match bundleHash");
  }
  return {
    launchId,
    gatewayNamespace,
    bundleHash: value.bundleHash,
    placementGeneration: requireNonNegativeInteger(
      value.placementGeneration,
      "placementGeneration",
    ),
    descriptor,
  };
}

export function parseNodeWorkerLookupInput(raw?: string | null): { launchId: string } {
  const value = decodeRequest(raw);
  if (!isRecord(value) || !hasExactKeys(value, ["launchId"])) {
    throw new Error("INVALID_REQUEST: invalid node worker lookup request");
  }
  return { launchId: requireIdentifier(value.launchId, "launchId") };
}

export function parseNodeWorkerCancelInput(raw?: string | null): NodeWorkerSupervisorIdentity {
  if (!raw || Buffer.byteLength(raw, "utf8") > NODE_WORKER_SUPERVISOR_CANCEL_REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker cancel request");
  }
  const value = decodeRequest(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "launchId",
      "planHash",
      "environmentId",
      "sessionId",
      "ownerEpoch",
      "placementGeneration",
      "runId",
    ])
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker cancel request");
  }
  if (typeof value.planHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.planHash)) {
    throw new Error("INVALID_REQUEST: planHash must be 64 lowercase hexadecimal characters");
  }
  return {
    launchId: requireIdentifier(value.launchId, "launchId"),
    planHash: value.planHash,
    environmentId: requireIdentifier(value.environmentId, "environmentId"),
    sessionId: requireIdentifier(value.sessionId, "sessionId"),
    ownerEpoch: requireNonNegativeInteger(value.ownerEpoch, "ownerEpoch"),
    placementGeneration: requireNonNegativeInteger(
      value.placementGeneration,
      "placementGeneration",
    ),
    runId: requireIdentifier(value.runId, "runId"),
  };
}

export function nodeWorkerPlanHash(
  input: Pick<
    NodeWorkerLaunchInput,
    "bundleHash" | "descriptor" | "gatewayNamespace" | "placementGeneration"
  >,
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        bundleHash: input.bundleHash,
        descriptor: input.descriptor,
        gatewayNamespace: input.gatewayNamespace,
        placementGeneration: input.placementGeneration,
      }),
    )
    .digest("hex");
}

export function projectNodeWorkerSupervisorReceipt(
  receipt: NodeWorkerLaunchReceipt,
): NodeWorkerSupervisorReceipt {
  return {
    launchId: receipt.launchId,
    planHash: receipt.planHash,
    environmentId: receipt.environmentId,
    sessionId: receipt.sessionId,
    ownerEpoch: receipt.ownerEpoch,
    placementGeneration: receipt.placementGeneration,
    runId: receipt.runId,
    state: receipt.state,
  };
}
