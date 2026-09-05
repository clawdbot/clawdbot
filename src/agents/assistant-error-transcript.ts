import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentMessage } from "./runtime/index.js";
import type { SessionManager } from "./sessions/index.js";

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
    record(message: AssistantMessage, target: TranscriptTarget): void {
      pending = {
        message,
        target: withOwnedSessionTranscriptWriterFence(target),
        assertActive: captureOwnedTranscriptWriteAssertion(target),
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
