import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { logVerbose } from "../../globals.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";

export async function finalizeAcceptedSteer(params: {
  activeReplyOperation: ReplyOperation | undefined;
  abortKey: string | undefined;
  cleanupTyping: () => void;
  errorMessage: string | undefined;
  onAdopted: (() => void | Promise<void>) | undefined;
  replyOperationRunState: ReplyOperationRunState | undefined;
  steerSessionId: string;
  transcriptCommit: "unconfirmed" | undefined;
}): Promise<"continue" | "stop"> {
  const transcriptCommitUnconfirmed = params.transcriptCommit === "unconfirmed";
  if (params.replyOperationRunState) {
    // Harness acceptance has transferred this turn to the active session.
    // Replay after an uncertain receipt could run the same user side effects twice.
    params.replyOperationRunState.admission = { status: "accepted", mode: "steer" };
  }
  params.activeReplyOperation?.recordActivity();
  const abortActiveRun = () => {
    if (params.abortKey) {
      replyRunRegistry.abort(params.abortKey);
    }
  };
  if (transcriptCommitUnconfirmed) {
    // Work without a confirmed canonical transcript must stop, but the source
    // remains adopted because harness acceptance is already irreversible.
    abortActiveRun();
    logVerbose(
      `queue: active session ${params.steerSessionId} accepted steering without transcript confirmation; aborting active run without ingress replay (${params.errorMessage ?? "unknown receipt failure"})`,
    );
  }
  const adoptionBoundary = transcriptCommitUnconfirmed ? "harness acceptance" : "transcript commit";
  try {
    await params.onAdopted?.();
  } catch (error) {
    if (isIngressAdoptionLostError(error)) {
      abortActiveRun();
      logVerbose(
        `queue: active session ${params.steerSessionId} adoption lost after ${adoptionBoundary} (${error.code}); aborting steered turn without ingress replay`,
      );
      params.cleanupTyping();
      return "stop";
    }
    logVerbose(
      `queue: active session ${params.steerSessionId} adoption finalizer failed after ${adoptionBoundary}: ${String(error)}`,
    );
  }
  if (transcriptCommitUnconfirmed) {
    params.cleanupTyping();
    return "stop";
  }
  return "continue";
}
