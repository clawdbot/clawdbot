import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { jsonResult } from "../../agents/tools/tool-results.js";
import { redactSensitiveText } from "../../logging/redact.js";

export class WorkerSessionToolOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Worker session operation outcome is unknown; it was not replayed", { cause });
    this.name = "WorkerSessionToolOutcomeUnknownError";
  }
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

function responseFrameBytes(resultJson: string): number {
  return Buffer.byteLength(
    JSON.stringify({
      type: "res",
      id: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH),
      ok: true,
      payload: { resultJson },
    }),
    "utf8",
  );
}

export function serializeWorkerSessionToolResult(result: unknown): string {
  const resultJson = JSON.stringify(result);
  if (responseFrameBytes(resultJson) > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
    return JSON.stringify(
      workerSessionToolErrorResult(new Error("Worker session tool result exceeded the limit")),
    );
  }
  return resultJson;
}
