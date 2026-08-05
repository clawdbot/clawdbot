import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import type { AgentMessage } from "./agent-core.js";
import {
  withProjectedSessionTranscriptWriteLock,
  type InternalSessionTranscriptWriteLockContext,
  type InternalSessionTranscriptWriteLockParams,
} from "./session-transcript-lock-runtime.js";
import { publishSessionTranscriptUpdateByIdentity } from "./session-transcript-runtime.js";

export type CodexSessionTranscriptMirrorWriteLockContext =
  InternalSessionTranscriptWriteLockContext & {
    appendMessageWithMessageSequence: <TMessage>(
      options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
    ) => Promise<{
      messageSeq?: number;
      result: TranscriptMessageAppendResult<TMessage> | undefined;
    }>;
    readMessageFacts: (params: { idempotencyKeys: readonly string[] }) => Promise<{
      existingIdempotencyKeys: Set<string>;
      messagesByIdempotencyKey: Map<string, AgentMessage>;
    }>;
  };

/** Runs the bundled Codex mirror under the transcript writer lock. */
export async function withCodexSessionTranscriptMirrorWriteLock<T>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: CodexSessionTranscriptMirrorWriteLockContext) => Promise<T> | T,
): Promise<T> {
  return await withProjectedSessionTranscriptWriteLock(
    params,
    run,
    (context, locked) => ({
      ...context,
      appendMessageWithMessageSequence: (options) =>
        locked.appendMessageWithMessageSequence({
          ...options,
          ...(params.config !== undefined ? { config: params.config } : {}),
        }),
      readMessageFacts: async (factParams) => {
        const facts = await locked.readMessageFacts(factParams);
        const messagesByIdempotencyKey = new Map<string, AgentMessage>();
        for (const [idempotencyKey, message] of facts.messagesByIdempotencyKey) {
          if (isAgentMessageRecord(message)) {
            messagesByIdempotencyKey.set(idempotencyKey, message);
          }
        }
        return { ...facts, messagesByIdempotencyKey };
      },
    }),
    publishSessionTranscriptUpdateByIdentity,
  );
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && typeof value.role === "string" && value.role.trim().length > 0;
}
