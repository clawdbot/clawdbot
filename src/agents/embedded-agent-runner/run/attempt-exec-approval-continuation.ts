import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import {
  resizeExecApprovalContinuationPrompt,
  type ExecApprovalContinuationPromptRange,
} from "../../bash-tools.exec-approval-output.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveLiveToolResultMaxChars } from "../../tool-result-limits.js";

export function prepareExecApprovalContinuationForAttempt(params: {
  prompt: string;
  transcriptPrompt?: string;
  promptRange?: ExecApprovalContinuationPromptRange;
  transcriptPromptRange?: ExecApprovalContinuationPromptRange;
  contextTokenBudget?: number;
  modelContextWindow?: number;
  modelMaxTokens?: number;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
}): { prompt: string; transcriptPrompt?: string } {
  if (!params.promptRange) {
    return { prompt: params.prompt, transcriptPrompt: params.transcriptPrompt };
  }
  const contextWindowTokens = Math.max(
    1,
    Math.floor(
      params.contextTokenBudget ??
        params.modelContextWindow ??
        params.modelMaxTokens ??
        DEFAULT_CONTEXT_TOKENS,
    ),
  );
  const maxOutputUtf16Units = resolveLiveToolResultMaxChars({ contextWindowTokens });
  const prompt = resizeExecApprovalContinuationPrompt({
    prompt: params.prompt,
    range: params.promptRange,
    maxOutputUtf16Units,
  });
  const transcriptPrompt =
    params.transcriptPrompt === undefined
      ? undefined
      : resizeExecApprovalContinuationPrompt({
          prompt: params.transcriptPrompt,
          range: params.transcriptPromptRange ?? params.promptRange,
          maxOutputUtf16Units,
        });
  params.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.(transcriptPrompt ?? prompt);
  return { prompt, transcriptPrompt };
}
