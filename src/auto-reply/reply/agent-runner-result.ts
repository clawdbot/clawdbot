import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import type { ReplyPayload } from "../types.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { markFollowupQueuePrecedingDelivery } from "./queue.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const accounting = await accountAgentTurn(context);
  // Runs queued behind this turn must know whether it already answered, so
  // drain-time prompt composition can acknowledge the delivery instead of
  // re-presenting the answer-expected hint (#126813). Record here, before the
  // payload-branch returns below: a message-tool-only delivery can settle with
  // delivery evidence but an empty payload array, and the queue drain runs
  // right after this finalize returns. Heartbeats do not answer and must not
  // overwrite the preceding turn's delivery fact.
  if (!context.isHeartbeat) {
    markFollowupQueuePrecedingDelivery({
      key: context.queueKey,
      precedingTurnDeliveredViaSourceReply: hasCompletedSourceReplyDeliveryEvidence(
        accounting.runResult,
      ),
    });
  }
  const prepared = await prepareReplyAgentPayloads({ context, accounting });
  if (prepared.kind === "return") {
    return prepared.value;
  }
  return await completeReplyAgentRun({ context, accounting, prepared });
}
