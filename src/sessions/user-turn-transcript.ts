// User turn transcript helpers extract user-turn text from session transcripts.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import {
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import { readPersistedMediaFacts, type MediaFact } from "../media/media-facts.js";
import { applyInputProvenanceToUserMessage, normalizeInputProvenance } from "./input-provenance.js";
import {
  buildLateResolvedMediaMessage,
  readUserTurnMessageMeta,
} from "./user-turn-transcript-late-media.js";
import { normalizeStructuredMediaEntryForTranscript } from "./user-turn-transcript.media-normalize.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  PersistUserTurnTranscriptParams,
  PersistedUserTurnMessage,
  UserTurnMessagePersistenceParams,
  UserTurnInput,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
  UserTurnTranscriptTargetResolver,
  UserTurnTranscriptUpdateMode,
} from "./user-turn-transcript.types.js";

export type {
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";
export { buildPersistedUserTurnMediaInputsFromFields } from "./user-turn-transcript.media-normalize.js";

export function buildRunUserTurnIdempotencyKey(runId: string): string {
  return `${runId}:user`;
}

// Select normalized text for persisted user turns.
export function resolvePersistedUserTurnText(value: string | null | undefined): string | undefined {
  return normalizeOptionalString(value);
}

export function buildLateMediaAttachedProjection(message: AgentMessage): {
  text?: string;
  media: MediaFact[];
} {
  const isLateMedia = readUserTurnMessageMeta(message)?.lateMedia === true;
  const media = isLateMedia ? (readPersistedMediaFacts(message) ?? []) : [];
  const text = media
    .flatMap((fact) => {
      const mediaRef = fact.path ?? fact.url;
      return mediaRef ? [`[media attached: ${mediaRef}]`] : [];
    })
    .join("\n");
  return { ...(text ? { text } : {}), media };
}

function buildUserTurnSenderMeta(
  sender: UserTurnInput["sender"],
): Record<string, string> | undefined {
  const senderId = normalizeOptionalString(sender?.id);
  const senderName = normalizeOptionalString(sender?.name);
  const senderUsername = normalizeOptionalString(sender?.username);
  if (!senderId && !senderName && !senderUsername) {
    return undefined;
  }
  return {
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
  };
}

export function buildPersistedUserTurnMessage(params: UserTurnInput): PersistedUserTurnMessage {
  const normalizedMedia = (params.media ?? []).map(normalizeStructuredMediaEntryForTranscript);
  const text = params.text ?? "";
  // Storage is BARE (no timestamp prefix). The per-message timestamp is added
  // at the single LLM-boundary stamping site (normalizeMessagesForLlmBoundary),
  // derived from each message's own `timestamp` field, so the current turn and
  // every historical turn serialize identically on the wire. Persisting a stamp
  // here would NOT match the bare-current arrival (the gateway no longer stamps
  // the live turn) — see https://github.com/openclaw/openclaw/issues/3658.
  const senderMeta = buildUserTurnSenderMeta(params.sender);
  const openClawMeta = {
    // Privileged synthetic handoffs may execute owner tools but never author trusted memory.
    ...(params.senderIsOwner === undefined
      ? {}
      : {
          senderIsOwner:
            params.senderIsOwner &&
            (!params.provenance || params.provenance.kind === "external_user"),
        }),
    ...senderMeta,
    ...(params.transport ? { transport: params.transport } : {}),
    ...(params.sessionDeliveryAckIds && params.sessionDeliveryAckIds.length > 0
      ? { sessionDeliveryAckIds: [...new Set(params.sessionDeliveryAckIds)] }
      : {}),
    ...(normalizedMedia.length > 0 ? { media: normalizedMedia } : {}),
    ...(params.mediaImageLayout
      ? {
          mediaImageLayout: {
            slots: params.mediaImageLayout.slots.map((slot) => ({ ...slot })),
            ...(params.mediaImageLayout.suppressedFactIndexes?.length
              ? {
                  suppressedFactIndexes: [...params.mediaImageLayout.suppressedFactIndexes],
                }
              : {}),
          },
        }
      : {}),
  };
  const message = {
    role: "user",
    content: text,
    timestamp: params.timestamp ?? Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(Object.keys(openClawMeta).length > 0 ? { __openclaw: openClawMeta } : {}),
  } as PersistedUserTurnMessage;
  return applyInputProvenanceToUserMessage(message, params.provenance) as PersistedUserTurnMessage;
}

function resolvePersistedUserTurnMessage(
  params: Pick<UserTurnMessagePersistenceParams, "input" | "message">,
): PersistedUserTurnMessage | undefined {
  if (params.message) {
    return params.message;
  }
  if (!params.input) {
    return undefined;
  }
  return buildPersistedUserTurnMessage(params.input);
}

function isUserMessage(message: AgentMessage): message is PersistedUserTurnMessage {
  return (message as { role?: unknown }).role === "user";
}

function isBeforeAgentRunBlockedMessage(message: AgentMessage): boolean {
  const marker = (message as { __openclaw?: { beforeAgentRunBlocked?: unknown } })["__openclaw"]
    ?.beforeAgentRunBlocked;
  return marker !== undefined;
}

function userMessageHasImageContent(message: AgentMessage): boolean {
  return (
    isUserMessage(message) &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "image",
    )
  );
}

// Runtime messages may lack transcript metadata because channel adapters prepare
// display text separately. Merge only safe user messages, never block markers.
export function mergePreparedUserTurnMessageForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (
    !params.preparedMessage ||
    !isUserMessage(params.runtimeMessage) ||
    isBeforeAgentRunBlockedMessage(params.runtimeMessage)
  ) {
    return params.runtimeMessage;
  }
  const runtimeMessage = params.runtimeMessage as unknown as Record<string, unknown>;
  const preparedMessage = params.preparedMessage as unknown as Record<string, unknown>;
  const runtimeMeta = readUserTurnMessageMeta(params.runtimeMessage);
  const preparedMeta = readUserTurnMessageMeta(params.preparedMessage);
  return {
    ...runtimeMessage,
    ...preparedMessage,
    ...(preparedMeta ? { __openclaw: { ...runtimeMeta, ...preparedMeta } } : {}),
    ...(userMessageHasImageContent(params.runtimeMessage)
      ? { content: params.runtimeMessage.content }
      : {}),
  } as unknown as AgentMessage;
}

/** Restores only auth state that write hooks must not be able to forge or erase. */
export function restorePreparedUserTurnOperationalMetaForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (!params.preparedMessage || !isUserMessage(params.runtimeMessage)) {
    return params.runtimeMessage;
  }
  const preparedMeta = readUserTurnMessageMeta(params.preparedMessage);
  const senderIsOwner = preparedMeta?.senderIsOwner;
  if (typeof senderIsOwner !== "boolean") {
    return params.runtimeMessage;
  }
  return {
    ...(params.runtimeMessage as unknown as Record<string, unknown>),
    __openclaw: { ...readUserTurnMessageMeta(params.runtimeMessage), senderIsOwner },
  } as unknown as AgentMessage;
}

/** Applies before-message hooks while preserving user-turn transcript metadata. */
export function preparePersistedUserTurnMessageForTranscriptWrite(
  message: PersistedUserTurnMessage,
  params: Pick<UserTurnMessagePersistenceParams, "agentId" | "sessionKey" | "beforeMessageWrite">,
): PersistedUserTurnMessage | undefined {
  if (!params.beforeMessageWrite) {
    return message;
  }
  const originalMessage = message as unknown as { idempotencyKey?: unknown };
  const idempotencyKey =
    typeof originalMessage.idempotencyKey === "string" ? originalMessage.idempotencyKey : undefined;
  const provenance = normalizeInputProvenance(
    (message as unknown as { provenance?: unknown }).provenance,
  );
  const senderIsOwner = readUserTurnMessageMeta(message)?.senderIsOwner;
  const originalTransport = readUserTurnMessageMeta(message)?.transport;
  const originalSessionDeliveryAckIds = readUserTurnMessageMeta(message)?.sessionDeliveryAckIds;
  const sessionDeliveryAckIds = Array.isArray(originalSessionDeliveryAckIds)
    ? [...originalSessionDeliveryAckIds]
    : undefined;
  const lateMedia = readUserTurnMessageMeta(message)?.lateMedia === true;
  const originalMedia = readUserTurnMessageMeta(message)?.media;
  const media = Array.isArray(originalMedia) ? structuredClone(originalMedia) : undefined;
  const originalMediaImageLayout = readUserTurnMessageMeta(message)?.mediaImageLayout;
  const mediaImageLayout =
    originalMediaImageLayout === undefined ? undefined : structuredClone(originalMediaImageLayout);
  // Hooks receive the original message object and may mutate nested metadata in
  // place. Snapshot transport correlation before handing them that reference.
  const originalTransportRecord = asOptionalRecord(originalTransport);
  const transport = originalTransportRecord ? { ...originalTransportRecord } : undefined;
  const nextMessage = params.beforeMessageWrite({
    message,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
  if (nextMessage?.role !== "user") {
    return undefined;
  }
  const nextUserMessage = provenance
    ? (applyInputProvenanceToUserMessage(nextMessage, provenance) as PersistedUserTurnMessage)
    : nextMessage;
  if (
    !idempotencyKey &&
    typeof senderIsOwner !== "boolean" &&
    !transport &&
    !Array.isArray(sessionDeliveryAckIds) &&
    !lateMedia &&
    media === undefined &&
    mediaImageLayout === undefined
  ) {
    return nextUserMessage;
  }
  const protectedMeta = {
    ...readUserTurnMessageMeta(nextUserMessage),
    ...(typeof senderIsOwner === "boolean" ? { senderIsOwner } : {}),
    ...(transport ? { transport } : {}),
    ...(Array.isArray(sessionDeliveryAckIds) ? { sessionDeliveryAckIds } : {}),
    ...(lateMedia ? { lateMedia: true } : {}),
    ...(media === undefined ? {} : { media }),
    ...(mediaImageLayout === undefined ? {} : { mediaImageLayout }),
  };
  return {
    ...(nextUserMessage as unknown as Record<string, unknown>),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(Object.keys(protectedMeta).length > 0 ? { __openclaw: protectedMeta } : {}),
  } as unknown as PersistedUserTurnMessage;
}

// Store-backed persistence resolves the current session transcript file lazily
// so callers can pass a session entry/store without knowing the final path.
async function persistUserTurnTranscript(
  params: PersistUserTurnTranscriptParams,
): Promise<UserTurnTranscriptPersistResult | undefined> {
  const message = resolvePersistedUserTurnMessage(params);
  if (!message) {
    return undefined;
  }

  const turn = await persistSessionTranscriptTurn(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      ...(params.sessionStore ? { sessionStore: params.sessionStore } : {}),
      ...(params.storePath ? { storePath: params.storePath } : {}),
      agentId: params.agentId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    },
    {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config
        ? { config: params.config as SessionTranscriptTurnPersistOptions["config"] }
        : {}),
      ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
      ...(params.expectedSessionState ? { expectedSessionState: params.expectedSessionState } : {}),
      ...(params.sessionLifecyclePatch
        ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
        : {}),
      updateMode: params.updateMode ?? "inline",
      messages: [
        {
          message,
          idempotencyLookup: "scan",
          prepareMessageAfterIdempotencyCheck: (candidate) =>
            preparePersistedUserTurnMessageForTranscriptWrite(
              candidate as PersistedUserTurnMessage,
              params,
            ),
        },
      ],
    },
  );
  const appended = turn.messages[0] as
    | {
        appended: boolean;
        messageId: string;
        message: PersistedUserTurnMessage;
      }
    | undefined;
  if (!appended) {
    return undefined;
  }

  return {
    ...appended,
    sessionEntry: turn.sessionEntry,
    sessionFile: params.sessionKey,
  };
}

async function resolveUserTurnTranscriptTarget(
  target: UserTurnTranscriptTargetResolver,
): Promise<UserTurnTranscriptTarget | undefined> {
  return typeof target === "function" ? await target() : target;
}

export function createUserTurnTranscriptRecorder(
  params: CreateUserTurnTranscriptRecorderParams,
): UserTurnTranscriptRecorder {
  let message = resolvePersistedUserTurnMessage(params);
  let blocked = false;
  let persisted = false;
  let runtimePersisted = false;
  let persistedResult: UserTurnTranscriptPersistResult | undefined;
  let runtimePersistencePromise: Promise<void> | undefined;
  let selfPersistencePromise: Promise<UserTurnTranscriptPersistResult | undefined> | undefined;
  let resolvedMessagePromise: Promise<PersistedUserTurnMessage | undefined> | undefined;
  let persistedMessageNotified = false;
  let runtimePersistedMessage: PersistedUserTurnMessage | undefined;
  let sentToProvider = false;
  let resolvedBeforeProvider = false;
  const replacementSessionDeliveryAckIds = new Set<string>();
  let hasReplacementSessionDeliveryAckIds = false;

  const replaceSessionDeliveryAckIds = (deliveryIds: readonly string[]): boolean => {
    if (selfPersistencePromise || runtimePersistencePromise || runtimePersisted || persisted) {
      return false;
    }
    hasReplacementSessionDeliveryAckIds = true;
    replacementSessionDeliveryAckIds.clear();
    for (const deliveryId of deliveryIds) {
      const normalized = deliveryId.trim();
      if (normalized) {
        replacementSessionDeliveryAckIds.add(normalized);
      }
    }
    return true;
  };

  const withReplacementSessionDeliveryAckIds = (
    candidate: PersistedUserTurnMessage | undefined,
  ): PersistedUserTurnMessage | undefined => {
    if (!candidate || !hasReplacementSessionDeliveryAckIds) {
      return candidate;
    }
    const metadata = { ...readUserTurnMessageMeta(candidate) };
    Reflect.deleteProperty(metadata, "sessionDeliveryAckIds");
    return {
      ...candidate,
      __openclaw: {
        ...metadata,
        ...(replacementSessionDeliveryAckIds.size > 0
          ? { sessionDeliveryAckIds: [...replacementSessionDeliveryAckIds] }
          : {}),
      },
    } as PersistedUserTurnMessage;
  };

  let replacementText: string | undefined;

  const applyReplacementText = (
    candidate: PersistedUserTurnMessage | undefined,
  ): PersistedUserTurnMessage | undefined => {
    if (!candidate || replacementText === undefined) {
      return candidate;
    }
    return { ...candidate, content: replacementText };
  };

  const handlePersistenceError = (error: unknown) => {
    if (params.onPersistenceError) {
      params.onPersistenceError(error);
      return;
    }
    void import("../globals.js")
      .then(({ logVerbose }) => {
        logVerbose(
          `failed to persist ${params.errorContext ?? "user turn transcript"}: ${String(error)}`,
        );
      })
      .catch(() => undefined);
  };

  const resolveMessageForPersistence = async (): Promise<PersistedUserTurnMessage | undefined> => {
    if (params.message || !params.resolveInput) {
      return withReplacementSessionDeliveryAckIds(applyReplacementText(message));
    }
    if (!resolvedMessagePromise) {
      resolvedMessagePromise = (async () => {
        try {
          const resolvedInput = await params.resolveInput?.();
          const resolvedMessage =
            resolvePersistedUserTurnMessage({
              message: params.message,
              input: resolvedInput ?? params.input,
            }) ?? message;
          resolvedBeforeProvider = !sentToProvider;
          return applyReplacementText(resolvedMessage);
        } catch (error) {
          handlePersistenceError(error);
          return applyReplacementText(message);
        }
      })();
    }
    return withReplacementSessionDeliveryAckIds(await resolvedMessagePromise);
  };

  const notifyMessagePersisted = (persistedMessage?: PersistedUserTurnMessage) => {
    const notificationMessage = persistedMessage ?? persistedResult?.message ?? message;
    if (!notificationMessage || persistedMessageNotified || !params.onMessagePersisted) {
      return;
    }
    persistedMessageNotified = true;
    try {
      void Promise.resolve(params.onMessagePersisted(notificationMessage)).catch(
        handlePersistenceError,
      );
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const waitForRuntimePersistence = async () => {
    if (!runtimePersistencePromise) {
      return;
    }
    try {
      await runtimePersistencePromise;
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const persistPrepared = async (options: {
    waitForRuntime: boolean;
    skipWhenBlocked: boolean;
    message?: PersistedUserTurnMessage;
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
    cwd?: string;
    expectedSessionId?: string;
    expectedSessionState?: SessionTranscriptTurnPersistOptions["expectedSessionState"];
    sessionLifecyclePatch?: SessionTranscriptTurnPersistOptions["sessionLifecyclePatch"];
    retryIfUnpersisted?: boolean;
  }): Promise<UserTurnTranscriptPersistResult | undefined> => {
    if (options.skipWhenBlocked && blocked) {
      return undefined;
    }
    if (!options.message && !message && !params.resolveInput) {
      return undefined;
    }
    if (options.waitForRuntime) {
      await waitForRuntimePersistence();
    }
    if (selfPersistencePromise) {
      const existingPromise = selfPersistencePromise;
      const existingResult = await existingPromise;
      if (existingResult || !options.retryIfUnpersisted) {
        return existingResult;
      }
      // A guarded store write can lose a session-generation race without appending.
      // Explicit retry callers may re-resolve the target, but concurrent ownership stays shared.
      if (selfPersistencePromise !== existingPromise) {
        return await selfPersistencePromise;
      }
      selfPersistencePromise = undefined;
    }
    const persistencePromise = (async () => {
      const resolvedMessage = options.message ?? (await resolveMessageForPersistence());
      if (!resolvedMessage) {
        return undefined;
      }
      const target = await resolveUserTurnTranscriptTarget(options.target ?? params.target);
      if (!target) {
        return undefined;
      }
      const resolvedTarget = options.cwd ? { ...target, cwd: options.cwd } : target;
      const updateMode = options.updateMode ?? params.updateMode ?? "inline";
      const persistMessage = async (
        candidate: PersistedUserTurnMessage,
        candidateUpdateMode: UserTurnTranscriptUpdateMode,
      ) =>
        await persistUserTurnTranscript({
          ...resolvedTarget,
          message: candidate,
          ...(options.expectedSessionId ? { expectedSessionId: options.expectedSessionId } : {}),
          ...((options.sessionLifecyclePatch ?? params.sessionLifecyclePatch)
            ? {
                sessionLifecyclePatch:
                  options.sessionLifecyclePatch ?? params.sessionLifecyclePatch,
              }
            : {}),
          ...((options.expectedSessionState ?? params.expectedSessionState)
            ? {
                expectedSessionState: options.expectedSessionState ?? params.expectedSessionState,
              }
            : {}),
          updateMode: candidateUpdateMode,
          ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
        });
      const lateMediaMessage =
        sentToProvider && !resolvedBeforeProvider
          ? buildLateResolvedMediaMessage({
              admittedMessage: runtimePersistedMessage ?? message,
              resolvedMessage,
            })
          : undefined;
      if (lateMediaMessage) {
        // The admitted bytes already crossed the LLM boundary. Persisting media as a
        // second turn preserves that prefix; inline replacement would thrash cache tail (#99495).
        if (!runtimePersisted && !persisted && message) {
          const admittedResult = await persistMessage(message, updateMode);
          if (admittedResult) {
            persisted = true;
            persistedResult = admittedResult;
            notifyMessagePersisted(admittedResult.message);
          }
        }
        const appendedMedia = await persistMessage(lateMediaMessage, "none");
        if (appendedMedia) {
          persisted = true;
          persistedResult = appendedMedia;
        }
        return appendedMedia;
      }
      if (runtimePersisted) {
        return undefined;
      }
      if (persisted) {
        return persistedResult;
      }
      const result = await persistMessage(resolvedMessage, updateMode);
      if (result) {
        persisted = true;
        persistedResult = result;
        notifyMessagePersisted(result.message);
      }
      return result;
    })();
    selfPersistencePromise = persistencePromise;
    try {
      const result = await persistencePromise;
      if (!result && options.retryIfUnpersisted && selfPersistencePromise === persistencePromise) {
        selfPersistencePromise = undefined;
      }
      return result;
    } catch (error) {
      handlePersistenceError(error);
      throw error;
    }
  };
  return {
    get message() {
      return message;
    },
    resolveMessage: resolveMessageForPersistence,
    replaceTextBeforePersistence: (text) => {
      if (persisted || runtimePersisted || sentToProvider) {
        return;
      }
      replacementText = text;
      message = applyReplacementText(message);
      resolvedMessagePromise = undefined;
    },
    getPersistedMessage: () => runtimePersistedMessage ?? persistedResult?.message,
    replaceSessionDeliveryAckIds,
    markSentToProvider: () => {
      sentToProvider = true;
    },
    markRuntimePersistencePending: (pending) => {
      runtimePersistencePromise = pending;
    },
    markRuntimePersisted: (persistedMessage) => {
      runtimePersistedMessage = persistedMessage;
      runtimePersisted = true;
      if (persistedMessage && persistedResult) {
        persistedResult = {
          ...persistedResult,
          message: persistedMessage,
        };
      }
      notifyMessagePersisted(persistedMessage);
    },
    markBlocked: () => {
      blocked = true;
    },
    hasPersisted: () => persisted || runtimePersisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => runtimePersistencePromise !== undefined,
    waitForRuntimePersistence,
    persistApproved: async (options) =>
      await persistPrepared({
        waitForRuntime: false,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
        expectedSessionId: options?.expectedSessionId,
        expectedSessionState: options?.expectedSessionState,
        sessionLifecyclePatch: options?.sessionLifecyclePatch,
        retryIfUnpersisted: options?.retryIfUnpersisted,
      }),
    persistBlocked: async (blockedMessage, options) => {
      blocked = true;
      return await persistPrepared({
        waitForRuntime: false,
        skipWhenBlocked: false,
        message: blockedMessage,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
      });
    },
    persistFallback: async (options) =>
      await persistPrepared({
        waitForRuntime: true,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
      }),
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.userTurnTranscriptTestApi")] = {
    persistUserTurnTranscript,
  };
}
