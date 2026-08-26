import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { projectAgentHarnessTranscriptMessageForDisplay } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAssistantProjection } from "./event-projector-assistant.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";
import { promptSnapshot } from "./user-prompt-message.js";

type TurnTaintMetadata = { resultContentSource?: "network"; turnTainted?: true };
const CODEX_META_KEY = "__openclaw";

function readTurnTaintMetadata(message: AgentMessage): TurnTaintMetadata | undefined {
  const metadata = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  return asOptionalRecord(metadata) as TurnTaintMetadata | undefined;
}

function applyStickyTurnTaint(messages: readonly AgentMessage[]): AgentMessage[] {
  let tainted = false;
  return messages.map((message) => {
    if (message.role === "user") {
      tainted = false;
      return message;
    }
    const metadata = readTurnTaintMetadata(message);
    tainted ||= metadata?.turnTainted === true || metadata?.resultContentSource === "network";
    return message.role === "assistant" && tainted
      ? ({ ...message, __openclaw: { ...metadata, turnTainted: true } } as AgentMessage)
      : message;
  });
}

export function buildCodexMessagesSnapshot(params: {
  runParams: EmbeddedRunAttemptParams;
  turnId: string;
  upstreamUserText: string | undefined;
  reasoningText: string | undefined;
  asyncMessages: ReadonlyArray<{ itemId: string; message: AssistantMessage }>;
  commentaryMessages: ReadonlyArray<{ itemId: string; message: AssistantMessage }>;
  toolMessages: readonly AgentMessage[];
  lastAssistant: AssistantMessage | undefined;
  lastAssistantIdentity?: string;
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
    ...params.toolMessages,
  ].toSorted(
    (left, right) =>
      (asDateTimestampMs(left.timestamp) ?? 0) - (asDateTimestampMs(right.timestamp) ?? 0),
  );
  messages.push(...visibleWorkMessages);
  if (params.lastAssistant) {
    messages.push(
      attachCodexMirrorIdentity(
        params.lastAssistant,
        params.lastAssistantIdentity ?? `${params.turnId}:assistant`,
      ),
    );
  }
  return applyStickyTurnTaint(messages).map((message) =>
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: params.runParams.trigger === "memory",
      message,
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
  const assistantBoundary = params.assistantProjection.createCompletedAssistantBoundaryMessage(
    params.completedItemIds,
    { tokenUsage: undefined, aborted: false, promptError: undefined },
  );
  const messages = buildCodexMessagesSnapshot({
    runParams: params.runParams,
    turnId: params.turnId,
    upstreamUserText: params.upstreamUserText,
    reasoningText: undefined,
    asyncMessages,
    commentaryMessages,
    toolMessages: params.toolMessages,
    lastAssistant: assistantBoundary?.message,
    ...(assistantBoundary
      ? { lastAssistantIdentity: `${params.turnId}:assistant:${assistantBoundary.itemId}` }
      : {}),
    createAssistantMirrorMessage: (title, text) =>
      params.assistantProjection.createAssistantMirrorMessage(title, text),
  }).filter((message) => message.role !== "user");
  return {
    messages,
    ...(assistantBoundary ? { assistantBoundaryItemId: assistantBoundary.itemId } : {}),
  };
}
