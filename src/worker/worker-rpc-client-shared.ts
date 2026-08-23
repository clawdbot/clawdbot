import type {
  WorkerErrorShape,
  WorkerLiveEventErrorShape,
  WorkerTranscriptCommitErrorShape,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceErrorShape } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerConnection } from "./worker-connection.js";

export type TranscriptResponseError = WorkerTranscriptCommitErrorShape | WorkerErrorShape;
export type LiveResponseError = WorkerLiveEventErrorShape | WorkerErrorShape;
export type InferenceResponseError = WorkerInferenceErrorShape | WorkerErrorShape;

export function fenceForOwnershipError(
  connection: WorkerConnection,
  response: TranscriptResponseError | LiveResponseError | InferenceResponseError,
): void {
  const reason = response.details.reason;
  if (reason === "epoch-mismatch" || reason === "owner-epoch-mismatch") {
    connection.fence("owner-epoch-mismatch");
  } else if (reason === "credential-replaced") {
    connection.fence("credential-replaced");
  }
}

export function isTerminalConnection(connection: WorkerConnection): boolean {
  return (
    connection.state.kind === "fenced" ||
    connection.state.kind === "failed" ||
    connection.state.kind === "stopped"
  );
}
