import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
  type WorkerLaunchPlan,
} from "./launch-descriptor.js";
import { parseWorkerAdmissionDeadlineResult } from "./worker-connection-contract.js";
import { WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES } from "./worker-connection-endpoint.js";
import type { WorkerRuntimeResult } from "./worker.runtime.js";

/** Private JSONL protocol between one node supervisor and its environment-owned worker. */
export type WorkerProcessInput =
  | { type: "turn"; turnId: string; descriptor: WorkerLaunchDescriptor }
  | { type: "cancel"; turnId: string };

export function buildWorkerProcessTurn<T extends WorkerLaunchPlan>(descriptor: T) {
  return { type: "turn" as const, turnId: descriptor.assignment.turnId, descriptor };
}

export function measureWorkerProcessTurnBytes(plan: WorkerLaunchPlan): number {
  // The node supplies the endpoint privately. Replace only its JSON null placeholder
  // with the parser-owned bound; the managed envelope is the sender's exact shape.
  return (
    Buffer.byteLength(
      JSON.stringify(buildWorkerProcessTurn({ ...plan, connectionEndpoint: null })),
    ) -
    "null".length +
    WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES
  );
}

export function serializeWorkerProcessInput(message: WorkerProcessInput): string {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json, "utf8") > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
    throw new Error("managed worker request exceeds the protocol payload limit");
  }
  return `${json}\n`;
}

export type WorkerProcessResult = {
  type: "result";
  turnId: string;
  result: WorkerRuntimeResult;
  retainWorker: boolean;
};

export function parseWorkerProcessRequest(value: unknown): WorkerProcessInput {
  if (
    !isRecord(value) ||
    typeof value.turnId !== "string" ||
    !value.turnId.trim() ||
    value.turnId.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH
  ) {
    throw new Error("invalid managed worker request");
  }
  if (value.type === "cancel" && Object.keys(value).length === 2) {
    return { type: "cancel", turnId: value.turnId };
  }
  if (value.type === "turn" && Object.keys(value).length === 3) {
    const descriptor = parseWorkerLaunchDescriptor(value.descriptor);
    if (descriptor.assignment.turnId !== value.turnId) {
      throw new Error("managed worker request disagrees with its assigned turn");
    }
    return { type: "turn", turnId: value.turnId, descriptor };
  }
  throw new Error("invalid managed worker request");
}

export function parseWorkerRuntimeResult(value: unknown): WorkerRuntimeResult | null {
  const admissionFailure = parseWorkerAdmissionDeadlineResult(value);
  if (admissionFailure) {
    return admissionFailure;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.status === "fenced" &&
    (value.reason === "credential-replaced" || value.reason === "owner-epoch-mismatch") &&
    Object.keys(value).length === 2
  ) {
    return { status: value.status, reason: value.reason };
  }
  if (
    (value.transcriptLeafId === null || typeof value.transcriptLeafId === "string") &&
    typeof value.transcriptNextSeq === "number" &&
    Number.isSafeInteger(value.transcriptNextSeq) &&
    value.transcriptNextSeq >= 1
  ) {
    const transcript = {
      transcriptLeafId: value.transcriptLeafId,
      transcriptNextSeq: value.transcriptNextSeq,
    };
    if (value.status === "completed" && Object.keys(value).length === 3) {
      return { status: value.status, ...transcript };
    }
    if (
      value.status === "failed" &&
      value.reason === "turn-failed" &&
      Object.keys(value).length === 4
    ) {
      return { status: value.status, reason: value.reason, ...transcript };
    }
  }
  return null;
}

export function parseWorkerProcessResult(value: unknown): WorkerProcessResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.type !== "result" ||
    typeof value.turnId !== "string" ||
    !value.turnId.trim() ||
    value.turnId.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH ||
    typeof value.retainWorker !== "boolean"
  ) {
    return null;
  }
  const result = parseWorkerRuntimeResult(value.result);
  if (
    !result ||
    (value.retainWorker && result.status !== "completed" && result.status !== "failed")
  ) {
    return null;
  }
  return { type: "result", turnId: value.turnId, result, retainWorker: value.retainWorker };
}
