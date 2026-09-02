// User turn transcript helpers extract user-turn text from session transcripts.
import { randomUUID } from "node:crypto";
import {
  bindSessionPendingInputSources,
  persistSessionTranscriptTurn,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  rewriteTranscriptMessageAtAnchor,
  type TranscriptEntryAnchor,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { resolveUserTurnTranscriptAdmission } from "./user-turn-transcript-admission.js";
import { registerUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-annotation.js";
import {
  buildLateResolvedMediaMessage,
  isUserMessage,
  resolvePersistedUserTurnMessage,
} from "./user-turn-transcript.message.js";
import {
  normalizePersistedSteerTargetRunId,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
  rewritePersistedSteerTargetRunId,
} from "./user-turn-transcript.metadata.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  PersistUserTurnTranscriptParams,
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
  UserTurnTranscriptTargetResolver,
  UserTurnTranscriptUpdateMode,
} from "./user-turn-transcript.types.js";

const pendingInputReceipts = new WeakMap<
  UserTurnTranscriptRecorder,
  () => Awaited<ReturnType<typeof stageSessionPendingInput>>
>();

export type {
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

export {
  buildLateMediaAttachedProjection,
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
  mergePreparedUserTurnMessageForRuntime,
  resolvePersistedUserTurnText,
} from "./user-turn-transcript.message.js";

export {
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
};

export function buildRunUserTurnIdempotencyKey(runId: string): string {
  return `${runId}:user`;
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
  let pendingInput: Awaited<ReturnType<typeof stageSessionPendingInput>>;
  let staging: Promise<boolean> | undefined;

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
    if (!params.message && params.resolveInput && !resolvedMessagePromise) {
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
    const resolved = await (params.message || !params.resolveInput
      ? applyMessageOverrides(message)
      : resolvedMessagePromise);
    if (!pendingInput && resolved && params.pendingInputSources) {
      const sources = params.pendingInputSources.flatMap(
        (source) => pendingInputReceipts.get(source)?.() ?? [],
      );
      if (sources.length > 0 && sources.length !== params.pendingInputSources.length) {
        throw new Error("Collected input cannot mix staged and unstaged source approval");
      }
      pendingInput = bindSessionPendingInputSources(sources, resolved);
      if (pendingInput) {
        message = pendingInput.message;
        resolvedMessagePromise = Promise.resolve(message);
      }
    }
    return pendingInput?.message ?? resolved;
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

  const refreshAdmission = (
    admission: UserTurnTranscriptAdmissionReceipt,
    persistedMessage: PersistedUserTurnMessage,
  ) => {
    admissionReceipt = admission;
    admittedMessage = persistedMessage;
    runtimePersistedMessage = persistedMessage;
    if (persistedResult) {
      persistedResult = { ...persistedResult, admission, message: persistedMessage };
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
        return persistedResult ?? existingResult;
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
      ) => {
        const persist = () =>
          persistUserTurnTranscript({
            ...resolvedTarget,
            logicalTurnId,
            message: candidate,
            sessionTurnMutation: params.sessionTurnMutation,
            expectedSessionId: options.expectedSessionId || resolvedTarget.expectedSessionId,
            sessionLifecyclePatch: options.sessionLifecyclePatch ?? params.sessionLifecyclePatch,
            expectedSessionState: options.expectedSessionState ?? params.expectedSessionState,
            updateMode: candidateUpdateMode,
            beforeMessageWrite: params.beforeMessageWrite ?? resolvedTarget.beforeMessageWrite,
          });
        // Collection can resolve its media lazily during admission. Bind custody
        // here too so the canonical append always consumes the exact sources.
        return await (pendingInput
          ? withSessionPendingInputPersistence(pendingInput, persist)
          : persist());
      };
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
  const recorder: UserTurnTranscriptRecorder = {
    get message() {
      return message;
    },
    resolveMessage: resolveMessageForPersistence,
    stageApproved: (options) => {
      staging ??= (async () => {
        const candidate = await resolveMessageForPersistence();
        const target = await resolveUserTurnTranscriptTarget(params.target);
        if (!candidate || !target || persisted || runtimePersisted) {
          return false;
        }
        pendingInput = await stageSessionPendingInput(target, {
          ...options,
          message: candidate,
          config: target.config as SessionTranscriptTurnPersistOptions["config"],
          prepareMessageAfterIdempotencyCheck: (next) =>
            preparePersistedUserTurnMessageForTranscriptWrite(next, {
              ...target,
              beforeMessageWrite: params.beforeMessageWrite ?? target.beforeMessageWrite,
            }),
        });
        if (!pendingInput) {
          return false;
        }
        message = pendingInput.message;
        resolvedMessagePromise = Promise.resolve(message);
        return pendingInput.state !== "consumed";
      })();
      return staging;
    },
    getPendingInputMessage: () => pendingInput?.message,
    isPendingInputConsumed: () => pendingInput?.state === "consumed",
    withPendingInput: (run) => (pendingInput ? pendingInput.run(run) : run()),
    finishPendingInput: (disposition) => {
      if (pendingInput) {
        pendingInput.finish(disposition);
      } else {
        for (const source of params.pendingInputSources ?? []) {
          source.finishPendingInput?.(disposition);
        }
      }
    },
    replaceTextBeforePersistence: (text) => {
      if (pendingInput || persisted || runtimePersisted || sentToProvider) {
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
        refreshAdmission(confirmed.admission, confirmed.message);
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
  pendingInputReceipts.set(recorder, () => pendingInput);
  registerUserTurnTranscriptAdmissionOwner(recorder, {
    receipt: () => admissionReceipt,
    message: () => admittedMessage,
    blocked: () => blocked || confirmedSteerTargetRunId !== undefined,
    refresh: refreshAdmission,
  });
  return recorder;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.userTurnTranscriptTestApi")] = {
    persistUserTurnTranscript,
  };
}
