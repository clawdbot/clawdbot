import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import type {
  TranscriptTurnAdmission,
  TranscriptEntryAnchor,
} from "../config/sessions/transcript-entry-anchor.js";
import type { AgentMessage } from "./agent-core.js";
import {
  withProjectedSessionTranscriptWriteLock,
  type InternalSessionTranscriptWriteLockContext,
  type InternalSessionTranscriptWriteLockParams,
} from "./session-transcript-lock-runtime.js";
import {
  readSessionTranscriptEvents,
  resolveSessionTranscriptIdentity,
  type SessionTranscriptTargetParams,
} from "./session-transcript-runtime.js";

/** Reads the bundled Codex mirror strictly before one admitted user row. */
export async function readCodexSessionTranscriptEventsBeforeAdmission(
  params: SessionTranscriptTargetParams,
  admission: TranscriptTurnAdmission,
) {
  const target = await resolveSessionTranscriptIdentity(params);
  if (
    target.agentId !== admission.agentId ||
    target.sessionId !== admission.sessionId ||
    target.sessionKey !== admission.sessionKey
  ) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript target",
    );
  }
  return await runWithSessionTranscriptReadFence(
    admission,
    async () => await readSessionTranscriptEvents(params),
  );
}

export type CodexSessionTranscriptMirrorWriteLockContext =
  InternalSessionTranscriptWriteLockContext & {
    appendMessageWithMessageSequence: <TMessage>(
      options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
    ) => Promise<{
      messageSeq?: number;
      result: TranscriptMessageAppendResult<TMessage> | undefined;
    }>;
    readMessageFacts: (params: { idempotencyKeys: readonly string[] }) => Promise<{
      anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
      existingIdempotencyKeys: Set<string>;
      messagesByIdempotencyKey: Map<string, AgentMessage>;
    }>;
  };

/** Runs the bundled Codex mirror under the transcript writer lock. */
export async function withCodexSessionTranscriptMirrorWriteLock<T>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: CodexSessionTranscriptMirrorWriteLockContext) => Promise<T> | T,
): Promise<T> {
  return await withProjectedSessionTranscriptWriteLock(params, run, (context, locked) => ({
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
  }));
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && typeof value.role === "string" && value.role.trim().length > 0;
}
