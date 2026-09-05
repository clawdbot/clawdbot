import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  visitSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
import { isMainSessionRestartRecoveryInputProvenance } from "../../sessions/input-provenance.js";
import { getTranscriptMessageRole } from "../embedded-agent-runner/message-visibility.js";
import { hasReplaySafeCodeModeCheckpointInCurrentTurn } from "./main-session-restart-recovery-resume-policy.js";

export async function readMainSessionReplaySafeCheckpoint(
  scope: SessionTranscriptReadScope,
): Promise<boolean> {
  let replaySafe = false;
  // The display tail can evict a checkpoint. Scan the active history snapshot
  // with constant memory; recovery inputs continue the original user turn.
  await visitSessionMessagesAsync(scope, (message) => {
    if (getTranscriptMessageRole(message) === "user") {
      if (!isMainSessionRestartRecoveryInputProvenance(asOptionalRecord(message)?.provenance)) {
        replaySafe = false;
      }
    } else if (hasReplaySafeCodeModeCheckpointInCurrentTurn([message])) {
      replaySafe = true;
    }
  });
  return replaySafe;
}
