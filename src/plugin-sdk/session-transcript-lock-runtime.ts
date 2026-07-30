import {
  publishTranscriptUpdate,
  resolveSessionTranscriptRuntimeTarget,
  withTranscriptWriteLock,
  type SessionTranscriptWriteLockAccessorContext,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "../config/sessions/session-accessor.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  formatSessionTranscriptMemoryHitKey,
  type SessionTranscriptMemoryHitKey,
  type SessionTranscriptReadParams,
} from "./session-transcript-memory-hit.js";

export type InternalSessionTranscriptTarget = {
  agentId: string;
  memoryKey: SessionTranscriptMemoryHitKey;
  sessionId: string;
  sessionKey: string;
  targetKind: "runtime-session";
};

export type InternalSessionTranscriptWriteLockParams = SessionTranscriptReadParams & {
  config?: TranscriptMessageAppendOptions<unknown>["config"];
};

export type InternalSessionTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishUpdate: (update?: TranscriptUpdatePayload) => Promise<void>;
  readEvents: () => Promise<unknown[]>;
  target: InternalSessionTranscriptTarget;
};

/** Resolves, locks, and publishes one projected transcript write context. */
export async function withProjectedSessionTranscriptWriteLock<
  T,
  TContext extends InternalSessionTranscriptWriteLockContext,
>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: TContext) => Promise<T> | T,
  projectContext: (
    context: InternalSessionTranscriptWriteLockContext,
    locked: SessionTranscriptWriteLockAccessorContext,
  ) => TContext,
  publishQueuedUpdate?: (
    params: InternalSessionTranscriptWriteLockParams & { update?: TranscriptUpdatePayload },
  ) => Promise<void>,
): Promise<T> {
  const storageTarget = await resolveSessionTranscriptRuntimeTarget(params);
  const agentId = normalizeAgentId(storageTarget.agentId);
  const target: InternalSessionTranscriptTarget = {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({
      agentId,
      sessionId: storageTarget.sessionId,
    }),
    sessionId: storageTarget.sessionId,
    sessionKey: storageTarget.sessionKey,
    targetKind: "runtime-session",
  };
  const boundScope = {
    ...params,
    sessionId: storageTarget.sessionId,
    sessionKey: storageTarget.sessionKey,
  };
  // Publish only after the write callback commits, so failed transactions cannot
  // expose transcript updates to gateway subscribers.
  const queuedUpdates: Array<TranscriptUpdatePayload | undefined> = [];
  const result = await withTranscriptWriteLock(
    boundScope,
    async (locked) =>
      await run(
        projectContext(
          {
            target,
            readEvents: locked.readEvents,
            appendMessage: (options) =>
              locked.appendMessage({
                ...options,
                ...(params.config !== undefined ? { config: params.config } : {}),
              }),
            publishUpdate: async (update) => {
              queuedUpdates.push(update ? { ...update } : undefined);
            },
          },
          locked,
        ),
      ),
  );
  for (const update of queuedUpdates) {
    if (publishQueuedUpdate) {
      await publishQueuedUpdate({
        ...boundScope,
        ...(update !== undefined ? { update } : {}),
      });
      continue;
    }
    await publishTranscriptUpdate(boundScope, {
      ...update,
      agentId: storageTarget.agentId,
      sessionKey: storageTarget.sessionKey,
      target: {
        agentId: storageTarget.agentId,
        sessionId: storageTarget.sessionId,
        sessionKey: storageTarget.sessionKey,
      },
    });
  }
  return result;
}
