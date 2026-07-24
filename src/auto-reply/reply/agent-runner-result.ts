import type { ReplyPayload } from "../types.js";
import { accountReplyAgentRun } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const accounting = await accountReplyAgentRun(context);
  const prepared = await prepareReplyAgentPayloads({ context, accounting });
  if (prepared.kind === "return") {
    return prepared.value;
  }
  return await completeReplyAgentRun({ context, accounting, prepared });
}
