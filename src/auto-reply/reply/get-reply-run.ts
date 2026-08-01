/** Prepares and runs auto-reply agent turns, including prompt context and session policy. */
import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";

function stripUntrustedMediaWorkspaceRoots(params: RunPreparedReplyParams): RunPreparedReplyParams {
  if (!params.opts?.media) {
    return params;
  }
  const strippedRootCount = params.opts.media.filter((fact) => fact.workspaceDir).length;
  if (strippedRootCount === 0) {
    return params;
  }
  logVerbose(
    `Ignoring ${strippedRootCount} supplied media workspace root(s) at the public reply ingress`,
  );
  return {
    ...params,
    opts: {
      ...params.opts,
      // GetReplyOptions is a public ingress. A supplied fact may identify a file, but it must not
      // add filesystem roots used by native hydration on either direct or queued execution paths.
      media: params.opts.media.map((fact) => {
        const sanitized = { ...fact };
        delete sanitized.workspaceDir;
        return sanitized;
      }),
    },
  };
}

/** Runs a prepared reply turn after session, prompt, queue, and policy state are resolved. */
export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const sanitizedParams = stripUntrustedMediaWorkspaceRoots(params);
  const context = await prepareReplyRunContext(sanitizedParams);
  if (context.kind === "reply") {
    return context.reply;
  }

  const admission = await prepareReplyRunAdmission(context);
  if (admission.kind === "reply") {
    return admission.reply;
  }

  return executePreparedReplyRun(admission);
}
