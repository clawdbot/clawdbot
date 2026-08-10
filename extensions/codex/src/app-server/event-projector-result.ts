import type {
  HeartbeatToolResponse,
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { CodexTurn } from "./protocol.js";

export type CodexAppServerToolTelemetry = {
  didSendViaMessagingTool: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
} & Pick<EmbeddedRunAttemptResult, "acceptedSessionSpawns">;

export function resolveCodexProjectedTerminalFailure<TSource extends string>(params: {
  completedTurn: CodexTurn | undefined;
  hadPromptFailureBeforeSynthesis: boolean;
  promptError: unknown;
  promptErrorSource: TSource | null;
  synthesizedMissingToolResultError: string | null;
}): {
  failed: boolean;
  error: unknown;
  source: TSource | "prompt" | null;
} {
  const turnFailed = params.completedTurn?.status === "failed";
  const failed =
    params.promptErrorSource !== null ||
    params.synthesizedMissingToolResultError !== null ||
    turnFailed;
  const error = params.hadPromptFailureBeforeSynthesis
    ? params.promptError
    : params.synthesizedMissingToolResultError !== null
      ? params.synthesizedMissingToolResultError
      : turnFailed
        ? (params.completedTurn?.error?.message ?? "codex app-server turn failed")
        : null;
  return {
    failed,
    error,
    source: failed ? (params.promptErrorSource ?? "prompt") : null,
  };
}
