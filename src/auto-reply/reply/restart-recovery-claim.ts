import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildRestartRecoveryClaimCleanupPatch,
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryBeforeAgentReplyState } from "../../config/sessions/restart-recovery-types.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { sessionMatchesExpectedTranscriptTurn } from "../../config/sessions/session-transcript-turn-state.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { createAgentRunStaleLifecycleError } from "../../infra/agent-lifecycle-error.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type ReplyRestartRecoveryClaimController = {
  admitUserTurn: (
    recorder?: UserTurnTranscriptRecorder,
  ) => Promise<"admitted" | "duplicate-source">;
  beginBeforeAgentReply: () => Promise<boolean>;
  checkpointBeforeAgentReply: (params: {
    state?: RestartRecoveryBeforeAgentReplyState;
    pendingFinalDelivery?: {
      context?: DeliveryContext;
      deliveries: NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"];
      intentId: string;
      text: string;
    };
  }) => Promise<void>;
  clear: () => Promise<void>;
  isArmed: () => boolean;
};

/** Provider redelivery guard shared by ingress and the agent admission boundary. */
export function isDuplicateRestartRecoverySource(
  entry: SessionEntry | null | undefined,
  sourceTurnId: unknown,
): boolean {
  const normalizedSourceTurnId = normalizeOptionalString(sourceTurnId);
  return Boolean(
    normalizedSourceTurnId &&
    (hasRestartRecoveryTerminalRun(entry ?? undefined, normalizedSourceTurnId) ||
      hasRestartRecoverySourceClaim(entry ?? undefined, normalizedSourceTurnId)),
  );
}

export async function retireTerminalRestartRecoverySourceClaim(params: {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
}): Promise<SessionEntry | undefined> {
  let didRetire = false;
  const retired = await updateSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    (current) => {
      if (
        current.sessionId !== params.sessionId ||
        current.status === "running" ||
        current.restartRecoveryDeliveryReceiptState === "terminal-pending" ||
        !hasRestartRecoverySourceClaim(current, params.sourceTurnId)
      ) {
        return null;
      }
      didRetire = true;
      return {
        ...buildRestartRecoveryClaimCleanupPatch({
          entry: current,
          recordTerminalSource: true,
          terminalSourceRunId: params.sourceTurnId,
        }),
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  return didRetire ? (retired ?? undefined) : undefined;
}

function buildExpectedSessionState(entry: SessionEntry): SessionTranscriptTurnExpectedState {
  return {
    abortedLastRun: entry.abortedLastRun,
    mainRestartRecoveryCycleId: entry.mainRestartRecovery?.cycleId,
    mainRestartRecoveryRevision: entry.mainRestartRecovery?.revision,
    restartRecoveryBeforeAgentReplyState: entry.restartRecoveryBeforeAgentReplyState,
    restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
    restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
    restartRecoveryDeliveryRequestFingerprint: entry.restartRecoveryDeliveryRequestFingerprint,
    restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
    restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
    restartRecoveryRequesterAccountId: entry.restartRecoveryRequesterAccountId,
    restartRecoveryRequesterSenderId: entry.restartRecoveryRequesterSenderId,
    restartRecoverySameChannelThreadRequired: entry.restartRecoverySameChannelThreadRequired,
    restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
    restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
    restartRecoveryTerminalRunIds: entry.restartRecoveryTerminalRunIds,
    status: entry.status,
  };
}

export function createReplyRestartRecoveryClaimController(params: {
  admissionRunId?: unknown;
  lifecycleGeneration: string | undefined;
  getEntry: () => SessionEntry | undefined;
  getSessionId: () => string;
  isRestartAbort: () => boolean;
  resolveDeliveryContext: (entry: SessionEntry | undefined) => DeliveryContext | undefined;
  requesterAccountId?: unknown;
  requesterSenderId?: unknown;
  resolveUserTurnTarget?: (params: {
    entry: SessionEntry;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => UserTurnTranscriptTarget | undefined;
  sessionKey?: string;
  setEntry: (entry: SessionEntry) => void;
  sameChannelThreadRequired?: boolean;
  sourceTurnId?: unknown;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  storePath?: string;
}): ReplyRestartRecoveryClaimController {
  let recoveryRunId: string = randomUUID();
  let recoverySourceRunId: string | undefined;
  let tracked = false;

  const persistAdmissionPatch = async (options: {
    entry: SessionEntry;
    patch: SessionTranscriptTurnLifecyclePatch;
    recorder?: UserTurnTranscriptRecorder;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<SessionEntry> => {
    const expectedSessionState = buildExpectedSessionState(options.entry);
    if (options.recorder && !options.recorder.hasPersisted()) {
      const result = await options.recorder.persistApproved({
        target: params.resolveUserTurnTarget?.({
          entry: options.entry,
          sessionId: options.sessionId,
          sessionKey: options.sessionKey,
          storePath: options.storePath,
        }),
        expectedSessionId: options.sessionId,
        expectedSessionState,
        sessionLifecyclePatch: options.patch,
      });
      if (!result?.sessionEntry) {
        throw new Error("session changed before durable user-turn admission");
      }
      return result.sessionEntry as SessionEntry;
    }
    const persisted = await updateSessionEntry(
      { storePath: options.storePath, sessionKey: options.sessionKey },
      (current) =>
        sessionMatchesExpectedTranscriptTurn(
          { entry: current },
          { expectedSessionId: options.sessionId, expectedSessionState },
        )
          ? options.patch
          : null,
    );
    if (!persisted) {
      throw new Error("restart recovery claim changed before agent adoption");
    }
    return persisted;
  };

  const persistUserTurnOnly = async (
    recorder: UserTurnTranscriptRecorder | undefined,
    sessionId: string,
  ): Promise<void> => {
    if (!recorder || recorder.hasPersisted()) {
      return;
    }
    const entry = params.getEntry();
    const target =
      entry && params.sessionKey && params.storePath
        ? params.resolveUserTurnTarget?.({
            entry,
            sessionId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          })
        : undefined;
    const result = await recorder.persistApproved({ target, expectedSessionId: sessionId });
    if (!result) {
      throw new Error("session changed before durable user-turn admission");
    }
    if (result.sessionEntry) {
      params.setEntry(result.sessionEntry as SessionEntry);
    }
  };

  const admitUserTurn: ReplyRestartRecoveryClaimController["admitUserTurn"] = async (recorder) => {
    if (!params.sessionKey || !params.storePath) {
      await recorder?.persistApproved();
      return "admitted";
    }
    const sessionId = params.getSessionId();
    const entry =
      loadSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        clone: false,
        hydrateSkillPromptRefs: false,
      }) ?? params.getEntry();
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error("session changed before durable user-turn admission");
    }
    const admissionRunId = normalizeOptionalString(params.admissionRunId);
    const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
    const activeClaimRunId = normalizeOptionalString(entry.restartRecoveryDeliveryRunId);
    const isExactRecoveryClaim = admissionRunId && activeClaimRunId === admissionRunId;
    if (sourceTurnId) {
      if (hasRestartRecoveryTerminalRun(entry, sourceTurnId)) {
        return "duplicate-source";
      }
      if (!isExactRecoveryClaim && hasRestartRecoverySourceClaim(entry, sourceTurnId)) {
        if (entry.status !== "running") {
          const retired = await retireTerminalRestartRecoverySourceClaim({
            sessionId,
            sessionKey: params.sessionKey,
            sourceTurnId,
            storePath: params.storePath,
          });
          if (retired) {
            params.setEntry(retired);
          }
        }
        return "duplicate-source";
      }
    }
    if (isExactRecoveryClaim) {
      if (entry.status !== "running" || entry.abortedLastRun === true) {
        throw new Error("restart recovery claim changed before agent adoption");
      }
      // Clear the retry verifier as the exact admitted claim crosses into execution.
      const preservesTerminalReceipt =
        entry.restartRecoveryDeliveryReceiptState === "terminal-pending";
      const adopted = await persistAdmissionPatch({
        entry,
        patch: {
          restartRecoveryBeforeAgentReplyState: undefined,
          ...(preservesTerminalReceipt
            ? {}
            : {
                restartRecoveryDeliveryReceiptState: undefined,
                restartRecoveryDeliveryToolCallId: undefined,
                restartRecoveryDeliveryRequestFingerprint: undefined,
              }),
          restartRecoverySourceIngress: entry.restartRecoverySourceIngress ?? "control-ui",
          updatedAt: Date.now(),
        },
        recorder,
        sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      params.setEntry(adopted);
      recoveryRunId = admissionRunId;
      recoverySourceRunId = normalizeOptionalString(adopted.restartRecoveryDeliverySourceRunId);
      tracked = true;
      return "admitted";
    }

    const deliveryContext = params.resolveDeliveryContext(entry);
    const recoverableDeliveryContext =
      deliveryContext && sourceTurnId ? deliveryContext : undefined;
    if (recoverableDeliveryContext) {
      const sourceMessage = recorder?.getPersistedMessage?.() ?? (await recorder?.resolveMessage());
      const persistedSourceTurnId = normalizeOptionalString(
        (sourceMessage as { idempotencyKey?: unknown } | undefined)?.idempotencyKey,
      );
      if (!recorder || persistedSourceTurnId !== sourceTurnId) {
        throw new Error("channel restart recovery requires source-keyed user-turn admission");
      }
    }
    if (!recoverableDeliveryContext && !activeClaimRunId) {
      // Source-less scheduled/ambient runs may execute, but cannot own a
      // channel recovery claim that would be impossible to correlate after restart.
      await persistUserTurnOnly(recorder, sessionId);
      return "admitted";
    }
    const updatedAt = Date.now();
    if (
      activeClaimRunId &&
      (entry.abortedLastRun === true ||
        entry.status === "running" ||
        entry.restartRecoveryDeliveryReceiptState === "terminal-pending")
    ) {
      throw new Error("restart recovery claim changed before agent adoption");
    }
    const retiredClaim = activeClaimRunId
      ? buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
          terminalSourceRunId: normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId),
        })
      : {};
    const patch: SessionTranscriptTurnLifecyclePatch = recoverableDeliveryContext
      ? {
          ...retiredClaim,
          abortedLastRun: false,
          endedAt: undefined,
          restartRecoveryBeforeAgentReplyState: undefined,
          restartRecoveryDeliveryReceiptState: undefined,
          restartRecoveryDeliveryToolCallId: undefined,
          restartRecoveryDeliveryContext: recoverableDeliveryContext,
          restartRecoveryDeliveryRequestFingerprint: undefined,
          restartRecoveryDeliveryRunId: recoveryRunId,
          restartRecoveryDeliverySourceRunId: sourceTurnId,
          restartRecoveryRequesterAccountId: sourceTurnId
            ? normalizeOptionalString(params.requesterAccountId)
            : undefined,
          restartRecoveryRequesterSenderId: sourceTurnId
            ? normalizeOptionalString(params.requesterSenderId)
            : undefined,
          restartRecoverySameChannelThreadRequired:
            sourceTurnId && params.sameChannelThreadRequired === true ? true : undefined,
          restartRecoverySourceIngress: sourceTurnId ? "channel" : undefined,
          restartRecoverySourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          runtimeMs: undefined,
          startedAt: updatedAt,
          status: "running",
          updatedAt,
        }
      : { ...retiredClaim, updatedAt };
    const persisted = await persistAdmissionPatch({
      entry,
      patch,
      recorder,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    params.setEntry(persisted);
    recoverySourceRunId = normalizeOptionalString(persisted.restartRecoveryDeliverySourceRunId);
    tracked = persisted.restartRecoveryDeliveryRunId === recoveryRunId;
    return "admitted";
  };

  const checkpointBeforeAgentReply: ReplyRestartRecoveryClaimController["checkpointBeforeAgentReply"] =
    async ({ state, pendingFinalDelivery }) => {
      if (!tracked || !params.sessionKey || !params.storePath) {
        return;
      }
      const updatedAt = Date.now();
      const persisted = await updateSessionEntry(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        (current) =>
          current.sessionId === params.getSessionId() &&
          current.restartRecoveryDeliveryRunId === recoveryRunId &&
          current.restartRecoveryDeliverySourceRunId === recoverySourceRunId &&
          current.restartRecoveryBeforeAgentReplyState === "pending"
            ? {
                restartRecoveryBeforeAgentReplyState: state,
                ...(pendingFinalDelivery
                  ? {
                      pendingFinalDelivery: {
                        ...(pendingFinalDelivery.text
                          ? { kind: "replayable" as const, text: pendingFinalDelivery.text }
                          : { kind: "transport-only" as const }),
                        createdAt: updatedAt,
                        ...(pendingFinalDelivery.intentId
                          ? { intentId: pendingFinalDelivery.intentId }
                          : {}),
                        deliveries: pendingFinalDelivery.deliveries,
                        ...(pendingFinalDelivery.context
                          ? { context: pendingFinalDelivery.context }
                          : {}),
                      },
                      // Hook-owned replies are already terminal. A restart may only deliver this
                      // checkpoint; it must never resume the model or broader tool surface.
                      restartRecoveryForceSafeTools: true,
                    }
                  : {}),
                updatedAt,
              }
            : null,
        { skipMaintenance: true, takeCacheOwnership: true },
      );
      if (!persisted) {
        throw new Error("before_agent_reply checkpoint lost restart recovery ownership");
      }
      params.setEntry(persisted);
    };

  const beginBeforeAgentReply: ReplyRestartRecoveryClaimController["beginBeforeAgentReply"] =
    async () => {
      if (!tracked || !params.sessionKey || !params.storePath) {
        return true;
      }
      // `pending` records only the ambiguous plugin side-effect window. A
      // finished unhandled hook clears it so recovery can re-enter normally.
      const updatedAt = Date.now();
      const persisted = await updateSessionEntry(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        (persistedCurrent) =>
          persistedCurrent.sessionId === params.getSessionId() &&
          persistedCurrent.restartRecoveryDeliveryRunId === recoveryRunId &&
          persistedCurrent.restartRecoveryDeliverySourceRunId === recoverySourceRunId &&
          persistedCurrent.restartRecoveryBeforeAgentReplyState === undefined
            ? { restartRecoveryBeforeAgentReplyState: "pending", updatedAt }
            : null,
        { skipMaintenance: true, takeCacheOwnership: true },
      );
      if (!persisted) {
        throw new Error("before_agent_reply start lost restart recovery ownership");
      }
      params.setEntry(persisted);
      return true;
    };

  const clear = async (): Promise<void> => {
    const lifecycleGeneration = params.lifecycleGeneration;
    if (
      !tracked ||
      !params.sessionKey ||
      !params.storePath ||
      !lifecycleGeneration ||
      params.isRestartAbort()
    ) {
      return;
    }
    const persisted = await patchSessionEntryCore(
      { storePath: params.storePath, sessionKey: params.sessionKey },
      (current) => {
        if (
          (current.abortedLastRun === true && current.mainRestartRecovery !== undefined) ||
          current.sessionId !== params.getSessionId() ||
          current.restartRecoveryDeliveryRunId !== recoveryRunId
        ) {
          return null;
        }
        // Unknown provider outcome is terminal for this live run. Retire its source without
        // replay so later distinct turns can proceed; a crash before this point leaves the
        // active receipt for restart-safe model reconciliation.
        if (current.restartRecoveryDeliveryReceiptState === "terminal-pending") {
          const endedAt = Date.now();
          return {
            ...buildRestartRecoveryClaimCleanupPatch({
              entry: current,
              recordTerminalSource: true,
              terminalSourceRunId: recoverySourceRunId,
            }),
            abortedLastRun: true,
            endedAt,
            lifecycleRunId: undefined,
            pendingFinalDelivery: undefined,
            runtimeMs:
              typeof current.startedAt === "number"
                ? Math.max(0, endedAt - current.startedAt)
                : undefined,
            status: "failed" as const,
            updatedAt: endedAt,
          };
        }
        const preservesPendingFinal = current.pendingFinalDelivery !== undefined;
        const completesHandledSilent =
          current.restartRecoveryBeforeAgentReplyState === "handled-silent" &&
          !preservesPendingFinal;
        const endedAt = completesHandledSilent ? Date.now() : undefined;
        return {
          ...buildRestartRecoveryClaimCleanupPatch({
            entry: current,
            recordTerminalSource: true,
            terminalSourceRunId: recoverySourceRunId,
          }),
          // Transport settlement owns this final checkpoint. Keep enough provenance for a
          // restart to enforce hook safety until that exact pending intent is resolved.
          ...(preservesPendingFinal
            ? {
                restartRecoveryBeforeAgentReplyState: current.restartRecoveryBeforeAgentReplyState,
                restartRecoverySourceIngress: current.restartRecoverySourceIngress,
                restartRecoveryForceSafeTools: current.restartRecoveryForceSafeTools,
              }
            : {}),
          ...(endedAt !== undefined
            ? {
                abortedLastRun: false,
                endedAt,
                lifecycleRunId: undefined,
                runtimeMs:
                  typeof current.startedAt === "number"
                    ? Math.max(0, endedAt - current.startedAt)
                    : undefined,
                status: "done" as const,
              }
            : {}),
          updatedAt: endedAt ?? Date.now(),
        };
      },
      {
        // Restart recovery can reuse this run id. Validate after async patch preparation,
        // inside the synchronous commit, so old cleanup cannot retire its successor's route.
        assertCommitAllowed: () => {
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          if (params.isRestartAbort()) {
            throw createAgentRunStaleLifecycleError();
          }
        },
      },
    );
    if (persisted) {
      params.setEntry(persisted);
    }
  };

  const isArmed = (): boolean => {
    if (!tracked || !params.sessionKey || !params.storePath) {
      return false;
    }
    const persisted = loadSessionEntry({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      clone: false,
      hydrateSkillPromptRefs: false,
    });
    return persisted?.abortedLastRun === true || params.getEntry()?.abortedLastRun === true;
  };

  return {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear,
    isArmed,
  };
}
