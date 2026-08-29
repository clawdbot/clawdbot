import type { WorkerTranscriptCommitRequestFrame } from "./schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_TRANSCRIPT_PAYLOAD_BYTES,
} from "./schema/worker-protocol-primitives.js";

/** Only image bytes may exceed the transcript's ordinary control budget. */
export function isWorkerTranscriptFrameWithinBudget(
  frame: WorkerTranscriptCommitRequestFrame,
): boolean {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (bytes > WORKER_PROTOCOL_MAX_TRANSCRIPT_PAYLOAD_BYTES) {
      return false;
    }
    let imageBytes = 0;
    for (const message of frame.params.messages) {
      for (const part of message.content) {
        if (part.type === "image") {
          imageBytes += Buffer.byteLength(JSON.stringify(part.data), "utf8") - 2;
        }
      }
    }
    return bytes - imageBytes <= WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}
