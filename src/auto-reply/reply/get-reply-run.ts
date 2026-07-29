/** Prepares and runs auto-reply agent turns, including prompt context and session policy. */
import type { ReplyPayload } from "../types.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";

/** Runs a prepared reply turn after session, prompt, queue, and policy state are resolved. */
export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const context = await prepareReplyRunContext(params);
  if (context.kind === "reply") {
    return context.reply;
  }

  const admission = await prepareReplyRunAdmission(context);
  if (admission.kind === "reply") {
    return admission.reply;
  }

  return executePreparedReplyRun(admission);
}
