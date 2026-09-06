import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasAssistantDisplayableNonTextContent,
  isAssistantTextContentType,
} from "../gateway/chat-display-projection.helpers.js";
import { hasPersistedMedia } from "../sessions/user-turn-media.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../shared/assistant-display-content.js";
import type { AgentMessage } from "./runtime/index.js";
import type { SessionManager } from "./sessions/index.js";
import { extractToolCallsFromAssistant } from "./tool-call-id.js";
import { makeZeroUsageSnapshot } from "./usage.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type TranscriptTarget = NonNullable<ReturnType<SessionManager["getSessionTarget"]>>;

/** Holds attempt failures until the logical run decides whether recovery succeeded. */
export function createAssistantErrorTranscript(params: { runId: string; config?: OpenClawConfig }) {
  let pending:
    | { message: AssistantMessage; target: TranscriptTarget; assertActive: () => void }
    | undefined;
  return {
    clear(): void {
      pending = undefined;
    },
    record(message: AssistantMessage, target: TranscriptTarget): AssistantMessage | undefined {
      // A recovered reply supersedes partial text (including stray "I"/"agree"
      // fragments). Facts must be appended now, before dependent tool results.
      pending = {
        message,
        target: withOwnedSessionTranscriptWriterFence(target),
        assertActive: captureOwnedTranscriptWriteAssertion(target),
      };
      const displayContent = readAssistantDisplayContent(message);
      if (
        !hasAssistantDisplayableNonTextContent(message) &&
        !hasAssistantDisplayableNonTextContent({ content: displayContent }) &&
        !hasPersistedMedia(message) &&
        !message.openclawDelivery?.mediaUrls?.length
      ) {
        return undefined;
      }
      const text = message.content.filter((block) => isAssistantTextContentType(block.type));
      const hasDisplayOverride = ASSISTANT_DISPLAY_CONTENT_FIELD in message;
      const { errorMessage, errorCode, errorType, errorBody, diagnostics, ...replayMessage } =
        message;
      // Facts and billing are recorded once; only text/error remains deferred.
      pending.message = {
        role: "assistant",
        api: message.api,
        provider: message.provider,
        model: message.model,
        content: text,
        ...(hasDisplayOverride
          ? {
              [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent.filter((block) =>
                isAssistantTextContentType(block.type),
              ),
            }
          : {}),
        usage: makeZeroUsageSnapshot(),
        stopReason: "error",
        errorMessage,
        errorCode,
        errorType,
        errorBody,
        diagnostics,
        timestamp: message.timestamp,
      };
      return {
        ...replayMessage,
        content: message.content.filter((block) => !isAssistantTextContentType(block.type)),
        ...(hasDisplayOverride
          ? {
              [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent.filter(
                (block) => !isAssistantTextContentType(block.type),
              ),
            }
          : {}),
        stopReason: extractToolCallsFromAssistant(message).length > 0 ? "toolUse" : "stop",
      };
    },
    async settle(failed: boolean): Promise<void> {
      const failure = pending;
      pending = undefined;
      if (!failed || !failure) {
        return;
      }
      const { message, target, assertActive } = failure;
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          assertCommitAllowed: assertActive,
          withTranscriptWrite: async (operation) => await operation(),
        },
        async () => {
          assertActive();
          const result = await appendExactAssistantMessageToSessionTranscript({
            ...target,
            expectedSessionId: target.sessionId,
            message,
            runId: params.runId,
            idempotencyKey: `${params.runId}:terminal-error`,
            config: params.config,
          });
          if (!result.ok) {
            throw new Error(`Failed to persist terminal assistant error: ${result.reason}`);
          }
        },
      );
    },
  };
}

export type AssistantErrorTranscript = ReturnType<typeof createAssistantErrorTranscript>;
