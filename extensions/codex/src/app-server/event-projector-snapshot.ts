import type {
  AgentMessage,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";
import { promptSnapshot } from "./user-prompt-message.js";

export function buildCodexMessagesSnapshot(params: {
  runParams: EmbeddedRunAttemptParams;
  turnId: string;
  upstreamUserText: string | undefined;
  reasoningText: string | undefined;
  planText: string | undefined;
  commentaryMessages: ReadonlyArray<{ itemId: string; message: AssistantMessage }>;
  toolMessages: readonly AgentMessage[];
  lastAssistant: AssistantMessage | undefined;
  createAssistantMirrorMessage: (title: string, text: string) => AssistantMessage;
}): AgentMessage[] {
  const messages = promptSnapshot(params.runParams, params.turnId, params.upstreamUserText);
  if (params.reasoningText) {
    messages.push(
      attachCodexMirrorIdentity(
        params.createAssistantMirrorMessage("Codex reasoning", params.reasoningText),
        `${params.turnId}:reasoning`,
      ),
    );
  }
  if (params.planText) {
    messages.push(
      attachCodexMirrorIdentity(
        params.createAssistantMirrorMessage("Codex plan", params.planText),
        `${params.turnId}:plan`,
      ),
    );
  }
  const commentaryMessages =
    params.runParams.config?.ui?.prefs?.chatPersistCommentary === false
      ? []
      : params.commentaryMessages.map(({ itemId, message }) =>
          attachCodexMirrorIdentity(message, `${params.turnId}:commentary:${itemId}`),
        );
  const visibleWorkMessages = [...commentaryMessages, ...params.toolMessages].toSorted(
    (left, right) =>
      (asDateTimestampMs(left.timestamp) ?? 0) - (asDateTimestampMs(right.timestamp) ?? 0),
  );
  messages.push(...visibleWorkMessages);
  if (params.lastAssistant) {
    messages.push(attachCodexMirrorIdentity(params.lastAssistant, `${params.turnId}:assistant`));
  }
  return messages;
}
