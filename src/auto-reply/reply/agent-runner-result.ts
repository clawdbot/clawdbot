import type { ReplyPayload } from "../types.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const accounting = await accountAgentTurn(context);
  if (context.execution.abortReason) {
    return context.returnWithQueuedFollowupDrain({ text: SILENT_REPLY_TOKEN });
  }
  const prepared = await prepareReplyAgentPayloads({ context, accounting });
  if (prepared.kind === "return") {
    return prepared.value;
  }
  return await completeReplyAgentRun({ context, accounting, prepared });
}
