// User turn transcript helpers extract user-turn text from session transcripts.
import { randomUUID } from "node:crypto";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import {
  persistSessionTranscriptTurn,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  rewriteTranscriptMessageAtAnchor,
  type TranscriptEntryAnchor,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { readPersistedMediaFacts, type MediaFact } from "../media/media-facts.js";
import { applyInputProvenanceToUserMessage } from "./input-provenance.js";
import { resolveUserTurnTranscriptAdmission } from "./user-turn-transcript-admission.js";
import {
  normalizeStructuredMediaEntryForTranscript,
  resolveTranscriptMediaPath,
} from "./user-turn-transcript.media-normalize.js";
import {
  buildPersistedUserTurnMetadata,
  normalizePersistedSteerTargetRunId,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
  rewritePersistedSteerTargetRunId,
} from "./user-turn-transcript.metadata.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  PersistUserTurnTranscriptParams,
  PersistedUserTurnMediaInput,
  PersistedUserTurnMessage,
  UserTurnMessagePersistenceParams,
  UserTurnInput,
  UserTurnTranscriptAdmissionReceipt,
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

export {
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
};

export function buildRunUserTurnIdempotencyKey(runId: string): string {
  return `${runId}:user`;
}

// Select normalized text for persisted user turns.
export function resolvePersistedUserTurnText(value: string | null | undefined): string | undefined {
  return normalizeOptionalString(value);
}

function resolveTranscriptMediaType(params: {
  explicitType: string | undefined;
  mediaPath: string | undefined;
  mediaUrl: string | undefined;
}): string | undefined {
  return params.explicitType ?? mimeTypeFromFilePath(params.mediaPath ?? params.mediaUrl);
}

export function buildPersistedUserTurnMediaInputsFromFields(
  fields: PersistedUserTurnMessage | null | undefined,
): PersistedUserTurnMediaInput[] {
  const facts = fields ? (readPersistedMediaFacts(fields) ?? []) : [];
  const normalizedMedia = facts.map((fact) => {
    const rawPath = normalizeOptionalString(fact.path);
    const mediaPath = rawPath
      ? resolveTranscriptMediaPath(rawPath, normalizeOptionalString(fact.workspaceDir))
      : undefined;
    const url = normalizeOptionalString(fact.url);
    if (!mediaPath && !url) {
      return {};
    }
    const contentType = resolveTranscriptMediaType({
      explicitType: normalizeOptionalString(fact.contentType),
      mediaPath,
      mediaUrl: url,
    });
    const media: PersistedUserTurnMediaInput = { contentType };
    if (mediaPath) {
      media.path = mediaPath;
    }
    if (url) {
      media.url = url;
    }
    if (fact.kind) {
      media.kind = fact.kind;
    }
    if (fact.fileName) {
      media.fileName = fact.fileName;
    }
    if (fact.sizeBytes !== undefined) {
      media.sizeBytes = fact.sizeBytes;
    }
    if (fact.durationMs !== undefined) {
      media.durationMs = fact.durationMs;
    }
    if (fact.width !== undefined) {
      media.width = fact.width;
    }
    if (fact.height !== undefined) {
      media.height = fact.height;
    }
    return media;
  });
  return normalizedMedia.some((entry) => entry.path || entry.url) ? normalizedMedia : [];
}

export function buildLateMediaAttachedProjection(message: AgentMessage): {
  text?: string;
  media: MediaFact[];
} {
  const isLateMedia = readOpenClawMessageMeta(message)?.lateMedia === true;
  const media = isLateMedia ? (readPersistedMediaFacts(message) ?? []) : [];
  const text = media
    .flatMap((fact) => {
      const mediaRef = fact.path ?? fact.url;
      return mediaRef ? [`[media attached: ${mediaRef}]`] : [];
    })
    .join("\n");
  return { ...(text ? { text } : {}), media };
}

function readOpenClawMessageMeta(message: AgentMessage): Record<string, unknown> | undefined {
  return asOptionalRecord(Reflect.get(message, "__openclaw"));
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
  const openClawMeta = buildPersistedUserTurnMetadata(params, normalizedMedia);
  const message = {
    role: "user",
    ...(params.display === false ? { display: false } : {}),
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
  return params.message ?? (params.input ? buildPersistedUserTurnMessage(params.input) : undefined);
}

function isUserMessage(message: unknown): message is PersistedUserTurnMessage {
  return asOptionalRecord(message)?.role === "user";
}

function buildLateResolvedMediaMessage(params: {
  admittedMessage?: PersistedUserTurnMessage;
  resolvedMessage: PersistedUserTurnMessage;
}): PersistedUserTurnMessage | undefined {
  const admittedMedia = buildPersistedUserTurnMediaInputsFromFields(params.admittedMessage);
  const resolvedMedia = buildPersistedUserTurnMediaInputsFromFields(params.resolvedMessage);
  if (
    resolvedMedia.length === 0 ||
    JSON.stringify(resolvedMedia) === JSON.stringify(admittedMedia)
  ) {
    return undefined;
  }
  const resolvedIdempotencyKey = Reflect.get(params.resolvedMessage, "idempotencyKey");
  const resolvedTimestamp = Reflect.get(params.resolvedMessage, "timestamp");
  const admittedContent = params.admittedMessage?.content;
  const resolvedContent = params.resolvedMessage.content;
  let content = resolvedContent;
  if (resolvedContent === admittedContent) {
    content = "";
  } else if (Array.isArray(resolvedContent) && typeof admittedContent === "string") {
    content = resolvedContent.filter((block) => {
      const textBlock = block as { type?: unknown; text?: unknown } | null;
      return textBlock?.type !== "text" || textBlock.text !== admittedContent;
    });
  }
  const idempotencyKey =
    typeof resolvedIdempotencyKey === "string" && resolvedIdempotencyKey.length > 0
      ? `${resolvedIdempotencyKey}:late-media`
      : `late-media:${typeof resolvedTimestamp === "number" ? resolvedTimestamp : Date.now()}`;
  // Like #111204, mark late-media scaffolding as wire-only so UIs never render it.
  return {
    ...params.resolvedMessage,
    content,
    idempotencyKey,
    __openclaw: { ...readOpenClawMessageMeta(params.resolvedMessage), lateMedia: true },
  } as PersistedUserTurnMessage;
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
  const runtimeMeta = readOpenClawMessageMeta(params.runtimeMessage);
  const preparedMeta = readOpenClawMessageMeta(params.preparedMessage);
  return {
    ...params.runtimeMessage,
    ...params.preparedMessage,
    ...(preparedMeta ? { __openclaw: { ...runtimeMeta, ...preparedMeta } } : {}),
    ...(userMessageHasImageContent(params.runtimeMessage)
      ? { content: params.runtimeMessage.content }
      : {}),
  } as AgentMessage;
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
      ...(params.initialSessionEntry ? { initialSessionEntry: params.initialSessionEntry } : {}),
      ...(params.expectedSessionState ? { expectedSessionState: params.expectedSessionState } : {}),
      ...(params.sessionLifecyclePatch
        ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
        : {}),
      ...(params.sessionTurnMutation ? { sessionTurnMutation: params.sessionTurnMutation } : {}),
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
  let appended = turn.messages[0] as
    | {
        anchor?: Omit<UserTurnTranscriptAdmissionReceipt, "logicalTurnId" | "role">;
        appended: boolean;
        messageId: string;
        message: PersistedUserTurnMessage;
      }
    | undefined;
  if (appended && !appended.anchor && appended.message.role === "user") {
    await waitForSessionTranscriptProjection(params);
    const anchor = readActiveTranscriptEntryAnchor({ ...params, entryId: appended.messageId });
    appended = anchor ? { ...appended, anchor } : appended;
  }
  if (!appended?.anchor || appended.message.role !== "user") {
    return undefined;
  }

  return {
    ...appended,
    admission: {
      ...appended.anchor,
      logicalTurnId: params.logicalTurnId ?? randomUUID(),
      role: "user",
    },
    sessionEntry: turn.sessionEntry,
    ...(turn.sessionTurnMutationResult
      ? { sessionTurnMutationResult: turn.sessionTurnMutationResult }
      : {}),
    sessionFile: params.sessionKey,
  };
}

async function resolveUserTurnTranscriptTarget(
  target: UserTurnTranscriptTargetResolver,
): Promise<UserTurnTranscriptTarget | undefined> {
  return typeof target === "function" ? await target() : target;
}

async function confirmPersistedSteerTargetRunId(params: {
  admission: UserTurnTranscriptAdmissionReceipt;
  targetRunId: string;
}): Promise<
  | {
      admission: UserTurnTranscriptAdmissionReceipt;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const rewritten = await rewriteTranscriptMessageAtAnchor(params.admission, (message) => {
    if (!isUserMessage(message)) {
      return undefined;
    }
    const currentTarget = normalizePersistedSteerTargetRunId(
      message["__openclaw"]?.steerTargetRunId,
    );
    return currentTarget === params.targetRunId
      ? undefined
      : rewritePersistedSteerTargetRunId(message, params.targetRunId);
  });
  if (!rewritten) {
    return undefined;
  }
  const admission = { ...params.admission, generation: rewritten.generation };
  await publishTranscriptUpdate(admission, {
    message: rewritten.message,
    messageId: admission.entryId,
    messageSeq: admission.activeMessagePosition + 1,
  });
  return { admission, message: rewritten.message };
}

export function createUserTurnTranscriptRecorder(
  params: CreateUserTurnTranscriptRecorderParams,
): UserTurnTranscriptRecorder {
  const logicalTurnId = randomUUID();
  let message = resolvePersistedUserTurnMessage(params);
  let blocked = false;
  let persisted = false;
  let runtimePersisted = false;
  let persistedResult: UserTurnTranscriptPersistResult | undefined;
  let admissionReceipt: UserTurnTranscriptAdmissionReceipt | undefined;
  let admittedMessage: PersistedUserTurnMessage | undefined;
  let runtimePersistencePromise: Promise<void> | undefined;
  let selfPersistencePromise: Promise<UserTurnTranscriptPersistResult | undefined> | undefined;
  let resolvedMessagePromise: Promise<PersistedUserTurnMessage | undefined> | undefined;
  let persistedMessageNotified = false;
  let runtimePersistedMessage: PersistedUserTurnMessage | undefined;
  let sentToProvider = false;
  let admissionHandler: ((admission: UserTurnTranscriptAdmissionReceipt) => void) | undefined;
  let resolvedBeforeProvider = false;
  let replacementText: string | undefined;
  let confirmedSteerTargetRunId: string | undefined;

  const applyReplacementText = (
    candidate: PersistedUserTurnMessage | undefined,
  ): PersistedUserTurnMessage | undefined => {
    if (!candidate || replacementText === undefined) {
      return candidate;
    }
    return { ...candidate, content: replacementText };
  };

  const applyMessageOverrides = (candidate: PersistedUserTurnMessage | undefined) =>
    rewritePersistedSteerTargetRunId(applyReplacementText(candidate), confirmedSteerTargetRunId);

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
      return applyMessageOverrides(message);
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
          return applyMessageOverrides(resolvedMessage);
        } catch (error) {
          handlePersistenceError(error);
          return applyMessageOverrides(message);
        }
      })();
    }
    return await resolvedMessagePromise;
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

  const recordAdmission = (
    receipt: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt,
    persistedMessage: PersistedUserTurnMessage,
  ) => {
    if (admissionReceipt) {
      return;
    }
    admissionReceipt = resolveUserTurnTranscriptAdmission({ logicalTurnId, receipt });
    admittedMessage = persistedMessage;
    admissionHandler?.(admissionReceipt);
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
          logicalTurnId,
          message: candidate,
          ...(params.sessionTurnMutation
            ? { sessionTurnMutation: params.sessionTurnMutation }
            : {}),
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
            recordAdmission(admittedResult.admission, admittedResult.message);
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
        recordAdmission(result.admission, result.message);
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
      message = applyMessageOverrides(message);
      resolvedMessagePromise = undefined;
    },
    confirmSteerTargetRunIdForPersistence: async (targetRunId) => {
      const normalizedTargetRunId = normalizePersistedSteerTargetRunId(targetRunId);
      if (!normalizedTargetRunId || confirmedSteerTargetRunId === normalizedTargetRunId) {
        return;
      }
      confirmedSteerTargetRunId = normalizedTargetRunId;
      message = applyMessageOverrides(message);
      resolvedMessagePromise = undefined;

      const pendingSelfPersistence = selfPersistencePromise;
      await waitForRuntimePersistence();
      await pendingSelfPersistence?.catch(() => undefined);
      if (!admissionReceipt) {
        return;
      }
      try {
        const confirmed = await confirmPersistedSteerTargetRunId({
          admission: admissionReceipt,
          targetRunId: normalizedTargetRunId,
        });
        if (!confirmed) {
          return;
        }
        admissionReceipt = confirmed.admission;
        admittedMessage = confirmed.message;
        runtimePersistedMessage = confirmed.message;
        if (persistedResult) {
          persistedResult = {
            ...persistedResult,
            admission: confirmed.admission,
            message: confirmed.message,
          };
        }
      } catch (error) {
        handlePersistenceError(error);
      }
    },
    getPersistedMessage: () =>
      admittedMessage ?? runtimePersistedMessage ?? persistedResult?.message,
    getAdmissionReceipt: () => admissionReceipt,
    setAdmissionHandler: (handler) => (admissionHandler = handler),
    markSentToProvider: () => {
      sentToProvider = true;
    },
    markRuntimePersistencePending: (pending) => {
      runtimePersistencePromise = pending;
    },
    markRuntimePersisted: (persistedMessage, receipt) => {
      runtimePersistedMessage = persistedMessage;
      runtimePersisted = true;
      if (persistedMessage && receipt) {
        recordAdmission(receipt, persistedMessage);
      }
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
