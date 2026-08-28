import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { projectAgentHarnessTranscriptMessageForDisplay } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { CodexAssistantProjection } from "./event-projector-assistant.js";
import { applyCodexTranscriptTaint } from "./transcript-mirror-attestation.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";
import { promptSnapshot } from "./user-prompt-message.js";

export function buildCodexMessagesSnapshot(params: {
  runParams: EmbeddedRunAttemptParams;
  turnId: string;
  upstreamUserText: string | undefined;
  reasoningText: string | undefined;
  asyncMessages: ReadonlyArray<{ itemId: string; message: AssistantMessage }>;
  commentaryMessages: ReadonlyArray<{ itemId: string; message: AssistantMessage }>;
  assistantMessages?: ReadonlyArray<{ itemId: string; message: AssistantMessage }>;
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
  const commentaryMessages =
    params.runParams.config?.ui?.prefs?.chatPersistCommentary === false
      ? []
      : params.commentaryMessages.map(({ itemId, message }) =>
          attachCodexMirrorIdentity(message, `${params.turnId}:commentary:${itemId}`),
        );
  const asyncMessages = params.asyncMessages.map(({ itemId, message }) =>
    attachCodexMirrorIdentity(message, `${params.turnId}:async:${itemId}`),
  );
  const visibleWorkMessages = [
    ...commentaryMessages,
    ...asyncMessages,
    ...(params.assistantMessages ?? []).map(({ itemId, message }) =>
      attachCodexMirrorIdentity(message, `${params.turnId}:assistant:${itemId}`),
    ),
    ...params.toolMessages,
  ].toSorted(
    (left, right) =>
      (asDateTimestampMs(left.timestamp) ?? 0) - (asDateTimestampMs(right.timestamp) ?? 0),
  );
  messages.push(...visibleWorkMessages);
  if (params.lastAssistant) {
    messages.push(attachCodexMirrorIdentity(params.lastAssistant, `${params.turnId}:assistant`));
  }
  const taint = { tainted: false };
  return messages.map((message) =>
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: params.runParams.trigger === "memory",
      message: applyCodexTranscriptTaint(message, taint),
    }),
  );
}

export function buildCodexSteeringMessagesSnapshot(params: {
  runParams: EmbeddedRunAttemptParams;
  turnId: string;
  upstreamUserText: string | undefined;
  completedItemIds: ReadonlySet<string>;
  assistantProjection: CodexAssistantProjection;
  toolMessages: readonly AgentMessage[];
}): { messages: AgentMessage[]; assistantBoundaryItemId?: string } {
  const asyncMessages = params.assistantProjection
    .collectAsyncMessages()
    .filter(({ itemId }) => params.completedItemIds.has(itemId));
  const commentaryMessages = params.assistantProjection
    .collectCommentaryMessages()
    .filter(({ itemId }) => params.completedItemIds.has(itemId));
  const assistantMessages = params.assistantProjection.collectCompletedAssistantMessages(
    params.completedItemIds,
  );
  const messages = buildCodexMessagesSnapshot({
    runParams: params.runParams,
    turnId: params.turnId,
    upstreamUserText: params.upstreamUserText,
    reasoningText: undefined,
    asyncMessages,
    commentaryMessages,
    assistantMessages,
    toolMessages: params.toolMessages,
    lastAssistant: undefined,
    createAssistantMirrorMessage: (title, text) =>
      params.assistantProjection.createAssistantMirrorMessage(title, text),
  }).filter((message) => message.role !== "user");
  return {
    messages,
    assistantBoundaryItemId: assistantMessages.at(-1)?.itemId,
  };
}
