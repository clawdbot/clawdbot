import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { jsonResult } from "../../agents/tools/tool-results.js";
import { sha256Base64Url, sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { redactSensitiveText } from "../../logging/redact.js";

export class WorkerSessionToolOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Worker session operation outcome is unknown; it was not replayed", { cause });
    this.name = "WorkerSessionToolOutcomeUnknownError";
  }
}

export function computeWorkerSessionToolRequestDigest(value: unknown): string {
  return sha256Base64Url(`openclaw.worker-session-tool-request.v1\0${JSON.stringify(value)}`);
}

export function workerSessionToolOperationKey(operationSeed: string, purpose: string): string {
  return sha256Base64Url(`openclaw.worker-session-tool-operation.v1\0${operationSeed}\0${purpose}`);
}

export function workerSessionToolErrorResult(error: unknown) {
  const message = redactSensitiveText(
    error instanceof Error ? error.message : "Worker session operation failed",
    { mode: "tools" },
  );
  return jsonResult({
    status: "error",
    error: truncateUtf16Safe(message, 1_024),
  });
}

export function serializeWorkerSessionToolResult(result: unknown): string {
  const resultJson = JSON.stringify(result);
  const responseFrameBytes = Buffer.byteLength(
    JSON.stringify({
      type: "res",
      id: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH),
      ok: true,
      payload: { resultJson },
    }),
    "utf8",
  );
  return responseFrameBytes > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES
    ? JSON.stringify(
        workerSessionToolErrorResult(new Error("Worker session tool result exceeded the limit")),
      )
    : resultJson;
}

export function throwIfWorkerSessionToolAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export function workerChildSessionKey(params: {
  operationSeed: string;
  targetAgentId: string;
}): string {
  const suffix = sha256HexPrefixCore(
    `openclaw.worker-session-tool-operation.v1\0${params.operationSeed}\0child-session`,
    32,
  );
  return `agent:${params.targetAgentId}:dashboard:cloud-${suffix}`;
}
