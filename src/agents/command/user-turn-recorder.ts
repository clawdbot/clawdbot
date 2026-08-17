import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import type { AgentCommandOpts } from "./types.js";

export function prepareAgentCommandUserTurnRecorder(params: {
  errorContext: string;
  opts: AgentCommandOpts;
  target: UserTurnTranscriptTarget;
  transcriptBody: string;
  useProvidedRecorder: boolean;
}): {
  recorder: UserTurnTranscriptRecorder;
  suppressUserTurnPersistence: boolean;
} {
  const transcriptMedia = params.opts.transcriptMedia ?? [];
  const suppressUserTurnPersistence =
    params.opts.suppressPromptPersistence === true ||
    (params.opts.transcriptMessage === "" && transcriptMedia.length === 0);
  const transcriptText = params.transcriptBody || undefined;
  const recorder =
    (params.useProvidedRecorder ? params.opts.userTurnTranscriptRecorder : undefined) ??
    createUserTurnTranscriptRecorder({
      ...(!suppressUserTurnPersistence && (transcriptText || transcriptMedia.length > 0)
        ? {
            input: {
              text: transcriptText,
              ...(transcriptMedia.length > 0 ? { media: transcriptMedia } : {}),
              senderIsOwner: params.opts.senderIsOwner,
              ...(params.opts.inputProvenance ? { provenance: params.opts.inputProvenance } : {}),
            },
          }
        : {}),
      target: params.target,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      errorContext: params.errorContext,
    });
  if (suppressUserTurnPersistence) {
    recorder.markBlocked();
  }
  return { recorder, suppressUserTurnPersistence };
}
