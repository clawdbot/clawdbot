import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseWorkerLaunchDescriptor, type WorkerLaunchDescriptor } from "./launch-descriptor.js";

const IDENTIFIER_MAX_CHARS = 256;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NODE_WORKER_SUPERVISOR_CANCEL_REQUEST_MAX_BYTES = 4 * 1024;
const NODE_WORKER_RESULT_JSON_MAX_BYTES = 64 * 1024;
const NODE_WORKER_ERROR_TEXT_MAX_BYTES = 4 * 1024;

export type NodeWorkerLaunchInput = {
  launchId: string;
  gatewayNamespace: string;
  bundleHash: string;
  placementGeneration: number;
  descriptor: WorkerLaunchDescriptor;
};

export type NodeWorkerSupervisorIdentity = {
  launchId: string;
  planHash: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  placementGeneration: number;
  runId: string;
};

type NodeWorkerSupervisorActiveReceipt = NodeWorkerSupervisorIdentity & {
  state: "pending" | "running";
};

type NodeWorkerSupervisorCompletedReceipt = NodeWorkerSupervisorIdentity & {
  state: "completed";
  resultJson: string;
};

type NodeWorkerSupervisorErrorReceipt = NodeWorkerSupervisorIdentity & {
  state: "failed" | "interrupted" | "cancelled";
  errorText: string;
};

export type NodeWorkerSupervisorReceipt =
  | NodeWorkerSupervisorActiveReceipt
  | NodeWorkerSupervisorCompletedReceipt
  | NodeWorkerSupervisorErrorReceipt;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX_CHARS &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function requireIdentifier(value: unknown, label: string): string {
  if (!isIdentifier(value)) {
    throw new Error(`INVALID_REQUEST: ${label} must be a bounded non-empty identifier`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`INVALID_REQUEST: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function isPlanHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
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
  if (!isPlanHash(value.bundleHash)) {
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
  if (!isPlanHash(value.planHash)) {
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

const RECEIPT_IDENTITY_KEYS = [
  "launchId",
  "planHash",
  "environmentId",
  "sessionId",
  "ownerEpoch",
  "placementGeneration",
  "runId",
] as const;

function parseReceiptIdentity(value: Record<string, unknown>): NodeWorkerSupervisorIdentity | null {
  if (
    !isIdentifier(value.launchId) ||
    !isPlanHash(value.planHash) ||
    !isIdentifier(value.environmentId) ||
    !isIdentifier(value.sessionId) ||
    !isNonNegativeInteger(value.ownerEpoch) ||
    !isNonNegativeInteger(value.placementGeneration) ||
    !isIdentifier(value.runId)
  ) {
    return null;
  }
  return {
    launchId: value.launchId,
    planHash: value.planHash,
    environmentId: value.environmentId,
    sessionId: value.sessionId,
    ownerEpoch: value.ownerEpoch,
    placementGeneration: value.placementGeneration,
    runId: value.runId,
  };
}

function isBoundedResultJson(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > NODE_WORKER_RESULT_JSON_MAX_BYTES
  ) {
    return false;
  }
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

function isBoundedErrorText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= NODE_WORKER_ERROR_TEXT_MAX_BYTES &&
    !/[\r\n]/u.test(value)
  );
}

export function parseNodeWorkerSupervisorReceipt(
  value: unknown,
): NodeWorkerSupervisorReceipt | null {
  if (!isRecord(value) || typeof value.state !== "string") {
    return null;
  }
  const identity = parseReceiptIdentity(value);
  if (!identity) {
    return null;
  }
  if (value.state === "pending" || value.state === "running") {
    return hasExactKeys(value, [...RECEIPT_IDENTITY_KEYS, "state"])
      ? { ...identity, state: value.state }
      : null;
  }
  if (value.state === "completed") {
    return hasExactKeys(value, [...RECEIPT_IDENTITY_KEYS, "state", "resultJson"]) &&
      isBoundedResultJson(value.resultJson)
      ? { ...identity, state: value.state, resultJson: value.resultJson }
      : null;
  }
  if (value.state === "failed" || value.state === "interrupted" || value.state === "cancelled") {
    return hasExactKeys(value, [...RECEIPT_IDENTITY_KEYS, "state", "errorText"]) &&
      isBoundedErrorText(value.errorText)
      ? { ...identity, state: value.state, errorText: value.errorText }
      : null;
  }
  return null;
}
