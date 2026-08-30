import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  runAgentHarnessBeforeMessageWriteHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  appendSessionTranscriptMessagesByIdentity,
  publishSessionTranscriptUpdateByIdentity,
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptTargetParams,
  type TranscriptEntryAnchor,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isCompatibleSingletonRewrite,
  isCompleteToolGroup,
  projectReplayPayload,
  type AttemptTranscriptMessage as TranscriptMessage,
} from "./attempt-transcript-replay.js";
import type { AttemptParamsLike } from "./attempt-types.js";

type TranscriptRecorder = NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>;
type AppendResult =
  | {
      anchor: TranscriptEntryAnchor;
      appended: boolean;
      message: TranscriptMessage;
      messageId: string;
    }
  | undefined;
type PendingWrite = {
  eventId?: string;
  message: TranscriptMessage;
  recorder?: TranscriptRecorder;
};
type ToolGroup = {
  assistant: PendingWrite;
  assistantKey: string;
  order: string[];
  results: Map<string, PendingWrite>;
};
type PersistenceReceipt = ReturnType<typeof createDeferred<void>>;

type TurnTaintMetadata = { resultContentSource?: "network"; turnTainted?: true };

function readTurnTaintMetadata(message: AgentMessage): TurnTaintMetadata | undefined {
  const metadata = (message as unknown as Record<string, unknown>)["__openclaw"];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as TurnTaintMetadata)
    : undefined;
}

function isActiveTurnTainted(messages: readonly AgentMessage[]): boolean {
  for (const message of messages.toReversed()) {
    if (message.role === "user") {
      return false;
    }
    const metadata = readTurnTaintMetadata(message);
    if (metadata?.turnTainted === true || metadata?.resultContentSource === "network") {
      return true;
    }
  }
  return false;
}

function withAssistantTurnTaint(
  message: Extract<AgentMessage, { role: "assistant" }>,
  tainted: boolean,
) {
  return tainted
    ? ({
        ...message,
        __openclaw: { ...readTurnTaintMetadata(message), turnTainted: true },
      } as typeof message)
    : message;
}

export type AttemptTranscriptJournal = ReturnType<typeof createAttemptTranscriptJournal>;

export function createAttemptTranscriptJournal(params: {
  abortSession: () => Promise<void>;
  attempt: AttemptParamsLike;
  messages: AgentMessage[];
  onInitialSdkUserValidated?: () => void;
  sdkSessionId: string;
}) {
  const hiddenTurn = params.attempt.trigger === "memory";
  const projectDisplay = (message: AgentMessage) =>
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: hiddenTurn || (message as { display?: boolean }).display === false,
      message,
    });
  const messagesSnapshot = [...params.messages];
  let turnTainted = isActiveTurnTainted(messagesSnapshot);
  const snapshotIdempotencyKeys = new Set(
    messagesSnapshot.flatMap((message) => {
      const key = readIdempotencyKey(message);
      return key && isCurrentJournalIdentity(key, params) ? [key] : [];
    }),
  );
  const replaceTailUser = (
    current: Extract<AgentMessage, { role: "user" }> | undefined,
    next?: AgentMessage,
  ) => {
    if (isSameUserTurn(messagesSnapshot.at(-1), current, `${params.attempt.runId}:user`)) {
      const removed = messagesSnapshot.pop();
      const removedKey = removed ? readIdempotencyKey(removed) : undefined;
      if (removedKey && isCurrentJournalIdentity(removedKey, params)) {
        snapshotIdempotencyKeys.delete(removedKey);
      }
    }
    if (next) {
      messagesSnapshot.push(next);
      const nextKey = readIdempotencyKey(next);
      if (nextKey && isCurrentJournalIdentity(nextKey, params)) {
        snapshotIdempotencyKeys.add(nextKey);
      }
    }
  };
  // The host recorder owns prompt construction. Missing recorders fail closed
  // before dispatch below; the journal never reconstructs a prompt string.
  const currentUser = params.attempt.userTurnTranscriptRecorder?.message;
  if (currentUser) {
    replaceTailUser(currentUser, projectDisplay(currentUser));
  }
  const target = resolveTranscriptTarget(params.attempt);
  const config = params.attempt.config;
  const seenEventIds = new Set<string>();
  const deferredUserWrites: PendingWrite[] = [];
  let pendingTools: ToolGroup | undefined;
  let queue = Promise.resolve();
  let firstFailure: Error | undefined;
  const sdkUserPersistenceReceipts = new Map<string, PersistenceReceipt>();
  const sdkUserRecorders = new Map<string, TranscriptRecorder>();
  let abortPromise: Promise<void> | undefined;
  let replayInvalid = false;
  let initialSdkUserObserved = false;
  let initialSdkUserValidated = false;
  let persistedInitialUser: Extract<AgentMessage, { role: "user" }> | undefined;
  let latestAssistantKey: string | undefined;
  let assistantTranscriptOwned = false;
  let assistantTranscriptIdempotencyKey: string | undefined;
  let terminalAnchor: TranscriptEntryAnchor | undefined;

  const captureFailure = (error: unknown) => {
    if (firstFailure) {
      return;
    }
    firstFailure = error instanceof Error ? error : new Error(String(error));
    replayInvalid = true;
    pendingTools = undefined;
    for (const receipt of sdkUserPersistenceReceipts.values()) {
      receipt.reject(firstFailure);
    }
    abortPromise = params.abortSession().catch(() => undefined);
  };
  const sdkUserPersistenceReceipt = (eventId: string) => {
    let receipt = sdkUserPersistenceReceipts.get(eventId);
    if (!receipt) {
      receipt = createDeferred<void>();
      // Unclaimed SDK events still need observable failures without unhandled rejections.
      void receipt.promise.catch(() => undefined);
      sdkUserPersistenceReceipts.set(eventId, receipt);
      if (firstFailure) {
        receipt.reject(firstFailure);
      }
    }
    return receipt;
  };
  const claim = (eventId: string) =>
    !firstFailure && !seenEventIds.has(eventId) && Boolean(seenEventIds.add(eventId));

  const schedule = (task: () => Promise<void> | void) => {
    if (firstFailure) {
      return;
    }
    // The SDK checkpoint can advance before this queue. SQLite closes the window inside a
    // complete group; a crash between groups leaves a structurally valid prefix.
    queue = queue.then(() => (firstFailure ? undefined : task())).catch(captureFailure);
  };

  const prepare = (
    write: PendingWrite,
    options: { singleton?: boolean } = {},
  ): TranscriptMessage | undefined => {
    const message = structuredClone(write.message) as TranscriptMessage;
    const originalReplayPayload = structuredClone(projectReplayPayload(message));
    const hooked = runAgentHarnessBeforeMessageWriteHook({
      message: structuredClone(message) as TranscriptMessage,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      // Tool-group narrative is replay state, not the dispatcher's terminal attachment reply.
      prepareAssistantTranscriptMessage:
        options.singleton && !hiddenTurn
          ? params.attempt.prepareAssistantTranscriptMessage
          : undefined,
    });
    if (!hooked) {
      return undefined;
    }
    if (
      !isDeepStrictEqual(originalReplayPayload, projectReplayPayload(hooked as TranscriptMessage))
    ) {
      replayInvalid = true;
    }
    const idempotencyKey = (message as { idempotencyKey?: string }).idempotencyKey;
    const taintMetadata = readTurnTaintMetadata(message);
    const toolIdentity =
      message.role === "toolResult"
        ? { toolCallId: message.toolCallId, toolName: message.toolName }
        : {};
    const prepared = projectDisplay({
      ...hooked,
      ...toolIdentity,
      ...(taintMetadata
        ? { __openclaw: { ...readTurnTaintMetadata(hooked), ...taintMetadata } }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(message.role === "user" && message.provenance ? { provenance: message.provenance } : {}),
      ...((message as { display?: boolean }).display === false ? { display: false } : {}),
    }) as TranscriptMessage;
    return options.singleton && !isCompatibleSingletonRewrite(message, prepared)
      ? undefined
      : prepared;
  };

  const append = async (write: PendingWrite): Promise<AppendResult> => {
    const outcome = await appendSessionTranscriptMessageByIdentityStrict({
      ...target,
      ...(config ? { config } : {}),
      ...(write.eventId ? { eventId: write.eventId } : {}),
      idempotencyLookup: "scan",
      message: write.message,
      prepareMessageAfterIdempotencyCheck: () => prepare(write, { singleton: true }),
    });
    if (outcome.kind === "suppressed") {
      write.recorder?.markBlocked();
      return undefined;
    }
    if (outcome.kind === "rejected") {
      throw new Error("Transcript session changed before singleton append");
    }
    if (
      !isDeepStrictEqual(
        projectReplayPayload(write.message),
        projectReplayPayload(outcome.result.message as TranscriptMessage),
      )
    ) {
      replayInvalid = true;
    }
    if (outcome.result.message.role === "user") {
      write.recorder?.markRuntimePersisted(outcome.result.message, outcome.result.anchor);
    }
    return outcome.result as AppendResult;
  };

  const appendToolGroup = async (group: ToolGroup) => {
    const writes = [group.assistant, ...group.order.map((id) => group.results.get(id)!)];
    const keys = writes.map((write) => readIdempotencyKey(write.message));
    const persistedKeys = new Set(
      (await readVisibleSessionTranscriptMessageEntries(target)).flatMap((entry) =>
        entry.idempotencyKey ? [entry.idempotencyKey] : [],
      ),
    );
    const persistedCount = keys.filter((key) => key && persistedKeys.has(key)).length;
    if (persistedCount > 0 && persistedCount < writes.length) {
      // The pre-atomic journal was never shipped. Partial identity is corruption,
      // not a runtime compatibility shape; recovery stays fail-closed.
      throw new Error("Copilot transcript found a partial persisted tool group");
    }
    // Hooks must finish before BEGIN. This skips steady-state replay hooks; the
    // transaction still revalidates all identities against cross-process races.
    const messages =
      persistedCount === writes.length
        ? writes.map((write) => write.message)
        : writes.map((write) => prepare(write));
    // Hook omission belongs to policy, but the journal owns structure: one block or
    // structurally destructive rewrite suppresses the complete assistant/result group.
    if (
      messages.some((message) => !message) ||
      !isCompleteToolGroup(messages as TranscriptMessage[], group.order)
    ) {
      return undefined;
    }
    const results = await appendSessionTranscriptMessagesByIdentity({
      ...target,
      ...(config ? { config } : {}),
      messages: writes.map((write, index) => ({
        eventId: write.eventId!,
        idempotencyLookup: "scan" as const,
        message: messages[index]!,
      })),
    });
    if (
      !isCompleteToolGroup(
        results.map((result) => result.message),
        group.order,
      )
    ) {
      throw new Error("Copilot transcript replayed an invalid tool group");
    }
    if (
      results.some(
        (result, index) =>
          !isDeepStrictEqual(
            projectReplayPayload(writes[index]!.message),
            projectReplayPayload(result.message as TranscriptMessage),
          ),
      )
    ) {
      replayInvalid = true;
    }
    return results;
  };

  const publish = async (appended: boolean) => {
    if (appended) {
      await publishSessionTranscriptUpdateByIdentity({ ...target }).catch((error: unknown) => {
        console.warn("[copilot-attempt] transcript update notification failed", error);
      });
    }
  };

  const accept = (result: AppendResult): boolean => {
    if (!result) {
      return false;
    }
    const key = readIdempotencyKey(result.message);
    const snapshotKey = key && isCurrentJournalIdentity(key, params) ? key : undefined;
    if (!snapshotKey || !snapshotIdempotencyKeys.has(snapshotKey)) {
      messagesSnapshot.push(result.message);
      if (snapshotKey) {
        snapshotIdempotencyKeys.add(snapshotKey);
      }
    }
    return result.appended;
  };
  const ownAssistant = (key: string, persisted: boolean, anchor?: TranscriptEntryAnchor) => {
    if (latestAssistantKey === key) {
      assistantTranscriptOwned = true;
      assistantTranscriptIdempotencyKey = persisted ? key : undefined;
      terminalAnchor = persisted ? anchor : undefined;
    }
  };

  const drainQueue = async () => {
    // SDK events can append work while an earlier write is pending. Drain until
    // the observed tail stays stable so finalization cannot outrun persistence.
    while (true) {
      const tail = queue;
      await tail;
      if (tail === queue) {
        break;
      }
    }
  };

  const barrier = async (boundary: string) => {
    await drainQueue();
    if (!firstFailure) {
      // Give an already-delivered SDK event one microtask turn to reach the
      // bridge, then re-drain without another yield before returning.
      await Promise.resolve();
      await drainQueue();
    }
    if (!firstFailure && pendingTools) {
      captureFailure(
        new Error(
          `Copilot transcript reached ${boundary} with unresolved tool results: ${pendingTools.order.join(", ")}`,
        ),
      );
    }
    if (abortPromise) {
      await abortPromise;
    }
    if (firstFailure) {
      const error = new Error(
        `[copilot-attempt] canonical transcript persistence failed: ${firstFailure.message}`,
        { cause: firstFailure },
      ) as Error & { code?: string };
      error.code = "transcript_persistence_failed";
      throw error;
    }
  };

  return {
    async sendSdkUser(send: () => Promise<string>, recorder?: TranscriptRecorder) {
      if (!recorder) {
        return await send();
      }
      const registration = createDeferred<void>();
      // SDK events can precede the send response. Queue the gate before dispatch,
      // then bind the returned id before releasing it; concurrent sends need no FIFO guessing.
      schedule(() => registration.promise);
      try {
        const messageId = await send();
        sdkUserRecorders.set(messageId, recorder);
        recorder.markSentToProvider?.();
        recorder.markRuntimePersistencePending(sdkUserPersistenceReceipt(messageId).promise);
        return messageId;
      } finally {
        registration.resolve();
      }
    },
    markReplayIncomplete() {
      replayInvalid = true;
    },
    recordAssistantProjectionGap() {
      replayInvalid = true;
      latestAssistantKey = undefined;
      assistantTranscriptOwned = false;
      assistantTranscriptIdempotencyKey = undefined;
      terminalAnchor = undefined;
    },
    async persistInitialUser() {
      const recorder = params.attempt.userTurnTranscriptRecorder;
      if (!recorder) {
        captureFailure(new Error("Copilot transcript requires a user-turn recorder"));
        return await barrier("user prompt");
      }
      if (recorder.isBlocked()) {
        replayInvalid = true;
        replaceTailUser(recorder.message);
        return;
      }
      const persistence = (async () => {
        const resolved = await recorder.resolveMessage();
        if (!resolved) {
          throw new Error("Copilot transcript user turn resolved without a message");
        }
        const outcome = await append({
          message: {
            ...resolved,
            idempotencyKey: `${params.attempt.runId}:user`,
          } as TranscriptMessage,
        });
        replaceTailUser(currentUser);
        if (!outcome) {
          replayInvalid = true;
          recorder.markBlocked();
          return;
        }
        const persisted = outcome.message as Extract<AgentMessage, { role: "user" }>;
        accept(outcome);
        persistedInitialUser = persisted;
        terminalAnchor = outcome.anchor;
        recorder.markRuntimePersisted(persisted, outcome.anchor);
        params.attempt.onUserMessagePersisted?.(persisted);
        await publish(outcome.appended);
      })();
      recorder.markRuntimePersistencePending(persistence);
      await persistence.catch(captureFailure);
      await barrier("user prompt");
    },
    recordSdkUser(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "user" }>;
      autopilotContinuation: boolean;
      replayIncomplete?: boolean;
    }) {
      const persistenceReceipt = sdkUserPersistenceReceipt(input.eventId);
      if (!claim(input.eventId)) {
        return;
      }
      replayInvalid ||= input.replayIncomplete === true;
      if (!initialSdkUserObserved && !input.autopilotContinuation) {
        initialSdkUserObserved = true;
        if (
          !persistedInitialUser ||
          userText(persistedInitialUser.content) !== userText(input.message.content)
        ) {
          replayInvalid = true;
        } else {
          initialSdkUserValidated = true;
          params.onInitialSdkUserValidated?.();
        }
        persistenceReceipt.resolve();
        return;
      }
      initialSdkUserObserved = true;
      schedule(async () => {
        const recorder = sdkUserRecorders.get(input.eventId);
        sdkUserRecorders.delete(input.eventId);
        const provenance = (await recorder?.resolveMessage())?.provenance;
        const write: PendingWrite = {
          eventId: input.eventId,
          message: provenance ? { ...input.message, provenance } : input.message,
          recorder,
        };
        if (pendingTools) {
          deferredUserWrites.push(write);
          return;
        }
        const outcome = await append(write);
        if (!outcome) {
          replayInvalid = true;
          persistenceReceipt.reject(new Error("Copilot steering user write was suppressed"));
          return;
        }
        await publish(accept(outcome));
        persistenceReceipt.resolve();
      });
    },
    recordAssistant(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "assistant" }>;
      replayIncomplete?: boolean;
      toolCallIds: string[];
    }) {
      if (!claim(input.eventId)) {
        return;
      }
      replayInvalid ||= input.replayIncomplete === true;
      const message = withAssistantTurnTaint(input.message, turnTainted);
      const key = `copilot-sdk:${params.sdkSessionId}:${input.eventId}`;
      latestAssistantKey = key;
      assistantTranscriptOwned = false;
      assistantTranscriptIdempotencyKey = undefined;
      terminalAnchor = undefined;
      schedule(async () => {
        if (pendingTools) {
          throw new Error("Copilot emitted an assistant message before tool results settled");
        }
        const write = {
          eventId: input.eventId,
          message: { ...message, idempotencyKey: key } as TranscriptMessage,
        };
        if (input.toolCallIds.length > 0) {
          pendingTools = {
            assistant: write,
            assistantKey: key,
            order: input.toolCallIds,
            results: new Map(),
          };
          return;
        }
        const outcome = await append(write);
        if (!outcome) {
          replayInvalid = true;
        }
        ownAssistant(key, Boolean(outcome), outcome?.anchor);
        await publish(accept(outcome));
      });
    },
    recordToolResult(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "toolResult" }>;
      replayIncomplete?: boolean;
    }) {
      if (!claim(input.eventId)) {
        return;
      }
      turnTainted ||= readTurnTaintMetadata(input.message)?.resultContentSource === "network";
      schedule(async () => {
        const group = pendingTools;
        if (!group || !group.order.includes(input.message.toolCallId)) {
          throw new Error(`Copilot emitted an unmatched tool result: ${input.message.toolCallId}`);
        }
        group.results.set(input.message.toolCallId, {
          eventId: input.eventId,
          message: {
            ...input.message,
            idempotencyKey: `copilot-sdk:${params.sdkSessionId}:${input.eventId}`,
          } as TranscriptMessage,
        });
        replayInvalid ||= input.replayIncomplete === true;
        if (!group.order.every((toolCallId) => group.results.has(toolCallId))) {
          return;
        }
        const results = await appendToolGroup(group);
        let appended = false;
        if (!results) {
          replayInvalid = true;
          ownAssistant(group.assistantKey, false);
        } else {
          for (const result of results) {
            appended = accept(result as AppendResult) || appended;
          }
          ownAssistant(group.assistantKey, true, results.at(-1)?.anchor);
        }
        pendingTools = undefined;
        const deferredReceipts: PersistenceReceipt[] = [];
        for (const write of deferredUserWrites.splice(0)) {
          const outcome = await append(write);
          if (!outcome) {
            replayInvalid = true;
            if (write.eventId) {
              sdkUserPersistenceReceipt(write.eventId).reject(
                new Error("Copilot steering user write was suppressed"),
              );
            }
            continue;
          }
          appended = accept(outcome) || appended;
          if (write.eventId) {
            deferredReceipts.push(sdkUserPersistenceReceipt(write.eventId));
          }
        }
        await publish(appended);
        for (const receipt of deferredReceipts) {
          receipt.resolve();
        }
      });
    },
    waitForSdkUserPersisted(eventId: string) {
      return sdkUserPersistenceReceipt(eventId).promise;
    },
    barrier,
    hasFailed: () => firstFailure !== undefined,
    snapshot: () => ({
      assistantTranscriptOwned,
      assistantTranscriptIdempotencyKey,
      terminalAnchor,
      initialSdkUserValidated,
      messagesSnapshot: [...messagesSnapshot],
      replayInvalid,
    }),
  };
}

function resolveTranscriptTarget(attempt: AttemptParamsLike): SessionTranscriptTargetParams {
  const sessionId = normalizeOptionalString(attempt.sessionTarget?.sessionId);
  const sessionKey = normalizeOptionalString(attempt.sessionTarget?.sessionKey);
  const storePath = normalizeOptionalString(attempt.sessionTarget?.storePath);
  if (!sessionId || !sessionKey || !storePath) {
    const error = new Error(
      "[copilot-attempt] canonical transcript persistence requires an exact runtime session target",
    ) as Error & { code?: string };
    error.code = "transcript_persistence_failed";
    throw error;
  }
  const agentId = normalizeOptionalString(attempt.sessionTarget?.agentId ?? attempt.agentId);
  return { sessionId, sessionKey, storePath, ...(agentId ? { agentId } : {}) };
}

function readIdempotencyKey(message: AgentMessage): string | undefined {
  const key = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key ? key : undefined;
}

function isCurrentJournalIdentity(
  key: string,
  params: { attempt: AttemptParamsLike; sdkSessionId: string },
): boolean {
  // Old mirror keys can be content fingerprints and are not turn identity.
  // Current journal keys use a run id or the SDK's unique event id.
  return (
    key === `${params.attempt.runId}:user` || key.startsWith(`copilot-sdk:${params.sdkSessionId}:`)
  );
}

function isSameUserTurn(
  candidate: AgentMessage | undefined,
  current: Extract<AgentMessage, { role: "user" }> | undefined,
  currentRunUserKey: string,
): boolean {
  if (candidate?.role !== "user" || !current) {
    return false;
  }
  if (candidate === current) {
    return true;
  }
  const candidateKey = (candidate as { idempotencyKey?: unknown }).idempotencyKey;
  const currentKey = (current as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof candidateKey === "string" || typeof currentKey === "string") {
    if (typeof candidateKey === "string" && typeof currentKey === "string") {
      return candidateKey === currentKey;
    }
    if (
      typeof candidateKey !== "string" ||
      typeof currentKey === "string" ||
      (!candidateKey.startsWith("copilot:") && candidateKey !== currentRunUserKey)
    ) {
      return false;
    }
  }
  // The embedded-runner boundary identifies the active user as the last user
  // and stamps it with this recorder timestamp; historical turns are ineligible.
  return (
    candidate.timestamp === current.timestamp &&
    userText(candidate.content) === userText(current.content)
  );
}

function userText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.length === 1) {
    const part = content[0] as { text?: unknown; type?: unknown };
    if (part?.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return JSON.stringify(content) ?? "";
}
