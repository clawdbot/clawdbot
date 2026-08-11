import { getRuntimeConfig } from "../../../config/config.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../../../config/sessions.js";
import { loadSessionEntry, patchSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  extractMessageRole,
  extractSessionTranscriptText,
  readSessionMessagesAsync,
} from "../../../gateway/session-transcript-readers.js";
import * as agentEvents from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
} from "../../../sessions/session-lifecycle-admission.js";
import { resolveInternalSessionEffectsTarget } from "../../internal-session-effects.js";
import {
  formatSubagentRecoveryWedgedReason,
  isSubagentRecoveryWedgedEntry,
} from "./subagent-recovery-state.js";
import {
  assertRestartRecoverySnapshotCurrent,
  buildRestartRecoveryIdempotencyKey,
  buildRestartRecoveryResumeMessage,
  getRestartRecoveryReplayError,
  isRestartRecoveryLifecycleCurrent,
} from "./subagent-registry-restart-recovery-helpers.js";
import { settleAcceptedRecoverySession } from "./subagent-registry-restart-recovery-session.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type {
  SubagentRestartRecoveryReceipt,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

const MAX_RECOVERY_ATTEMPTS = 2;
const RECOVERY_ATTEMPT_WINDOW_MS = 2 * 60_000;
type SubagentRunManager = ReturnType<typeof createSubagentRunManager>;

export type RestartRecoveryResult =
  | { status: "ignored" }
  | { status: "handled" }
  | { status: "deferred" }
  | { status: "accepted" }
  | { status: "retry"; error: string }
  | {
      status: "terminal";
      error: string;
      endedAt?: number;
      suppressSessionEffects?: boolean;
      target?: { runId: string; entry: SubagentRunRecord };
    };

export type RestartRecoveryParams = {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  gatewayRuntime: GatewayRecoveryRuntime | undefined;
  isCurrent: (runId: string, entry: SubagentRunRecord) => boolean;
  abandonLaunch: SubagentRunManager["abandonSubagentRestartRecoveryLaunch"];
  clearAcceptedRecovery: SubagentRunManager["clearAcceptedSubagentRestartRecovery"];
  getRun: (runId: string) => SubagentRunRecord | undefined;
  replaceRun: SubagentRunManager["replaceSubagentRunAfterSteer"];
  markLaunchAttempted: SubagentRunManager["markSubagentRestartRecoveryLaunchAttempted"];
  markLaunchAccepted: SubagentRunManager["markSubagentRestartRecoveryLaunchAccepted"];
  markLaunchConsumed: SubagentRunManager["markSubagentRestartRecoveryLaunchConsumed"];
  resetLaunchAttempt: SubagentRunManager["resetSubagentRestartRecoveryLaunchAttempt"];
  reserveLaunch: SubagentRunManager["reserveSubagentRestartRecoveryLaunch"];
  resumeAcceptedRecovery: SubagentRunManager["resumeSettledSubagentRestartRecovery"];
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

async function reconcileAcceptedRecovery(params: {
  agentId: string;
  attempts: number;
  childSessionKey: string;
  currentSessionId?: string;
  currentSessionLifecycleRevision?: string;
  clearAcceptedRecovery: RestartRecoveryParams["clearAcceptedRecovery"];
  entry: SubagentRunRecord;
  getRun: RestartRecoveryParams["getRun"];
  isCurrent: RestartRecoveryParams["isCurrent"];
  now: number;
  receipt: SubagentRestartRecoveryReceipt;
  replaceRun: RestartRecoveryParams["replaceRun"];
  resumeAcceptedRecovery: RestartRecoveryParams["resumeAcceptedRecovery"];
  runId: string;
  storePath: string;
  warn: RestartRecoveryParams["warn"];
}): Promise<RestartRecoveryResult> {
  let owner = params.entry;
  if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
    return {
      status: "terminal",
      error: "retired Gateway lifecycle",
      suppressSessionEffects: true,
      target: { runId: owner.runId, entry: owner },
    };
  }
  if (params.runId !== params.receipt.idempotencyKey) {
    let remapped = false;
    try {
      remapped =
        params.isCurrent(params.runId, params.entry) &&
        params.replaceRun({
          previousRunId: params.runId,
          nextRunId: params.receipt.idempotencyKey,
          fallback: params.entry,
          expected: params.entry,
          transcriptTarget: resolveInternalSessionEffectsTarget({
            agentId: params.agentId,
            runId: params.receipt.idempotencyKey,
            storePath: params.storePath,
          }),
          task: params.entry.task,
          restartRecovery: params.receipt,
          persistenceFailure: "return-false",
        });
    } catch {}
    if (!remapped) {
      params.warn("accepted subagent restart recovery could not remap its exact row", {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
      });
      return {
        status: "deferred",
      };
    }
    const successor = params.getRun(params.receipt.idempotencyKey);
    if (
      !successor ||
      successor.execution.restartRecovery !== params.receipt ||
      !params.isCurrent(successor.runId, successor)
    ) {
      params.warn("accepted subagent restart recovery lost its remapped owner", {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
      });
      return { status: "deferred" };
    }
    owner = successor;
  }
  const ownsAcceptedTarget = () =>
    params.isCurrent(owner.runId, owner) &&
    owner.execution.restartRecovery === params.receipt &&
    isRestartRecoveryLifecycleCurrent(params.receipt);

  if (
    !params.currentSessionId ||
    params.currentSessionId !== params.receipt.sessionId ||
    (params.receipt.sessionLifecycleRevision !== undefined &&
      params.currentSessionLifecycleRevision !== params.receipt.sessionLifecycleRevision)
  ) {
    return {
      status: "terminal",
      error:
        "accepted subagent restart recovery lost its exact session before ownership settlement",
      suppressSessionEffects: true,
      target: { runId: owner.runId, entry: owner },
    };
  }

  try {
    if (
      !(await settleAcceptedRecoverySession({
        attempts: params.attempts,
        childSessionKey: params.childSessionKey,
        isOwnerCurrent: ownsAcceptedTarget,
        sessionId: params.receipt.sessionId,
        sessionLifecycleRevision: params.receipt.sessionLifecycleRevision,
        now: params.now,
        runId: owner.runId,
        storePath: params.storePath,
      }))
    ) {
      if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
        return {
          status: "terminal",
          error: "retired Gateway lifecycle",
          suppressSessionEffects: true,
          target: { runId: owner.runId, entry: owner },
        };
      }
      params.warn("accepted subagent restart recovery session changed during settlement", {
        runId: owner.runId,
        childSessionKey: params.childSessionKey,
      });
      return { status: "deferred" };
    }
  } catch (error) {
    if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
      return {
        status: "terminal",
        error: "retired Gateway lifecycle",
        suppressSessionEffects: true,
        target: { runId: owner.runId, entry: owner },
      };
    }
    params.warn("accepted subagent restart recovery could not clear its abort marker", {
      runId: owner.runId,
      childSessionKey: params.childSessionKey,
      error,
    });
    return { status: "deferred" };
  }
  if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
    return {
      status: "terminal",
      error: "retired Gateway lifecycle",
      suppressSessionEffects: true,
      target: { runId: owner.runId, entry: owner },
    };
  }
  try {
    if (
      !ownsAcceptedTarget() ||
      !params.clearAcceptedRecovery({
        runId: owner.runId,
        expected: owner,
        sessionId: params.receipt.sessionId,
        idempotencyKey: params.receipt.idempotencyKey,
      })
    ) {
      params.warn("accepted subagent restart recovery could not retire its receipt", {
        runId: owner.runId,
        childSessionKey: params.childSessionKey,
      });
      return { status: "deferred" };
    }
  } catch (error) {
    params.warn("accepted subagent restart recovery could not persist receipt retirement", {
      error,
      runId: owner.runId,
      childSessionKey: params.childSessionKey,
    });
    return { status: "deferred" };
  }
  if (
    !params.isCurrent(owner.runId, owner) ||
    !params.resumeAcceptedRecovery({
      runId: owner.runId,
      expected: owner,
    })
  ) {
    params.warn("accepted subagent restart recovery lost its settled owner", {
      runId: owner.runId,
      childSessionKey: params.childSessionKey,
    });
    return { status: "deferred" };
  }
  return { status: "accepted" };
}

export async function recoverInterruptedSubagentRow(
  params: RestartRecoveryParams,
): Promise<RestartRecoveryResult> {
  const recoveryLifecycleGeneration = agentEvents.getAgentEventLifecycleGeneration();
  const isRecoveryAttemptLifecycleCurrent = () =>
    agentEvents.isAgentEventLifecycleGenerationCurrent(recoveryLifecycleGeneration);
  const initialRecoveryReceipt = params.entry.execution.restartRecovery;
  const legacyRestartTimeout =
    params.entry.execution.outcome?.status === "timeout" &&
    typeof params.entry.execution.endedAt === "number";
  const acceptedRecoveryCurrent =
    initialRecoveryReceipt?.phase === "accepted" && params.isCurrent(params.runId, params.entry);
  const isRecoverySourceCurrent = () =>
    isRecoveryAttemptLifecycleCurrent() &&
    params.isCurrent(params.runId, params.entry) &&
    params.entry.pauseReason !== "sessions_yield" &&
    params.entry.suppressAnnounceReason !== "steer-restart" &&
    params.entry.killReconciliation === undefined &&
    params.entry.killIntent === undefined &&
    typeof params.entry.execution.endedAt !== "number";
  if (initialRecoveryReceipt && !isRestartRecoveryLifecycleCurrent(initialRecoveryReceipt)) {
    return {
      status: "terminal",
      error: "retired Gateway lifecycle",
      endedAt: params.entry.execution.endedAt,
      suppressSessionEffects: true,
    };
  }
  if (!acceptedRecoveryCurrent) {
    const terminalError = getRestartRecoveryReplayError(params.entry);
    if (terminalError) {
      return { status: "terminal", error: terminalError, endedAt: params.entry.execution.endedAt };
    }
  }
  if (!acceptedRecoveryCurrent && !legacyRestartTimeout && !isRecoverySourceCurrent()) {
    return { status: "ignored" };
  }

  const childSessionKey = params.entry.childSessionKey.trim();
  if (!childSessionKey) {
    return { status: "ignored" };
  }
  try {
    const agentId = resolveAgentIdFromSessionKey(childSessionKey);
    const storePath = resolveStorePath(getRuntimeConfig().session?.store, { agentId });
    const sessionEntry = loadSessionEntry({
      storePath,
      sessionKey: childSessionKey,
      clone: false,
    });
    const recovery = sessionEntry?.subagentRecovery;
    const attempts =
      typeof recovery?.lastAttemptAt === "number" &&
      Number.isFinite(recovery.lastAttemptAt) &&
      params.now - recovery.lastAttemptAt <= RECOVERY_ATTEMPT_WINDOW_MS &&
      typeof recovery.automaticAttempts === "number" &&
      Number.isFinite(recovery.automaticAttempts) &&
      recovery.automaticAttempts > 0
        ? Math.floor(recovery.automaticAttempts)
        : 0;
    const currentRecoveryReceipt = params.entry.execution.restartRecovery;
    const abandonedError =
      "subagent restart recovery was abandoned after an ambiguous Gateway restart; " +
      "automatic replay was suppressed to avoid duplicate side effects";
    if (currentRecoveryReceipt && !isRestartRecoveryLifecycleCurrent(currentRecoveryReceipt)) {
      return {
        status: "terminal",
        error: "retired Gateway lifecycle",
        endedAt: params.entry.execution.endedAt,
        suppressSessionEffects: true,
      };
    }
    if (currentRecoveryReceipt?.phase === "accepted") {
      return await reconcileAcceptedRecovery({
        agentId,
        attempts,
        childSessionKey,
        currentSessionId: sessionEntry?.sessionId,
        currentSessionLifecycleRevision: sessionEntry?.lifecycleRevision,
        clearAcceptedRecovery: params.clearAcceptedRecovery,
        entry: params.entry,
        getRun: params.getRun,
        isCurrent: params.isCurrent,
        now: params.now,
        receipt: currentRecoveryReceipt,
        replaceRun: params.replaceRun,
        resumeAcceptedRecovery: params.resumeAcceptedRecovery,
        runId: params.runId,
        storePath,
        warn: params.warn,
      });
    }
    if (currentRecoveryReceipt?.phase === "abandoned") {
      return { status: "terminal", error: abandonedError };
    }
    if (
      currentRecoveryReceipt?.phase === "attempted" ||
      currentRecoveryReceipt?.phase === "consumed"
    ) {
      if (
        !params.abandonLaunch({
          runId: params.runId,
          expected: params.entry,
          sessionMarker: currentRecoveryReceipt.sessionMarker,
          idempotencyKey: currentRecoveryReceipt.idempotencyKey,
        })
      ) {
        return {
          status: "retry",
          error: "ambiguous subagent restart recovery could not persist its terminal fence",
        };
      }
      return { status: "terminal", error: abandonedError };
    }
    if (!sessionEntry?.abortedLastRun) {
      return { status: "ignored" };
    }
    const marker = `${sessionEntry.sessionId ?? ""}:${sessionEntry.updatedAt ?? ""}`;
    if (typeof params.entry.execution.endedAt === "number" && !legacyRestartTimeout) {
      return { status: "ignored" };
    }
    if (legacyRestartTimeout) {
      const interruptedAt = params.entry.execution.endedAt;
      params.entry.execution = {
        ...params.entry.execution,
        status: "interrupted",
        interruptedAt,
        interruptionReason: "gateway-restart",
        endedAt: undefined,
        outcome: undefined,
      };
      params.entry.endedReason = undefined;
      params.entry.terminalOwner = undefined;
    }
    if (isStaleUnendedSubagentRun(params.entry, params.now)) {
      const age = Math.round(
        (params.now - (getSubagentSessionStartedAt(params.entry) ?? params.now)) / 1_000,
      );
      return {
        status: "terminal",
        error: `stale aborted subagent run not resumed (${age}s old, exceeds stale-run window)`,
      };
    }

    const alreadyWedged = isSubagentRecoveryWedgedEntry(sessionEntry);
    const blockedReason = alreadyWedged
      ? formatSubagentRecoveryWedgedReason(sessionEntry)
      : attempts >= MAX_RECOVERY_ATTEMPTS
        ? `subagent orphan recovery blocked after ${attempts} rapid accepted resume attempts; ` +
          `run "openclaw tasks maintenance --apply" or "openclaw doctor --fix" to reconcile it`
        : undefined;
    if (blockedReason) {
      if (!alreadyWedged) {
        try {
          await patchSessionEntry(
            { storePath, sessionKey: childSessionKey },
            (current) => {
              current.abortedLastRun = false;
              current.subagentRecovery = {
                ...current.subagentRecovery,
                automaticAttempts: Math.max(
                  current.subagentRecovery?.automaticAttempts ?? 0,
                  MAX_RECOVERY_ATTEMPTS,
                ),
                lastAttemptAt: current.subagentRecovery?.lastAttemptAt ?? params.now,
                lastRunId: params.runId,
                wedgedAt: params.now,
                wedgedReason: blockedReason,
              };
              current.updatedAt = params.now;
              return current;
            },
            {
              assertCommitAllowed: () => {
                if (!isRecoverySourceCurrent() || !isRecoveryAttemptLifecycleCurrent()) {
                  throw new Error("subagent recovery lifecycle retired before wedge commit");
                }
              },
              replaceEntry: true,
              skipMaintenance: true,
            },
          );
        } catch (error) {
          if (!isRecoveryAttemptLifecycleCurrent()) {
            return {
              status: "terminal",
              error: "retired Gateway lifecycle",
              suppressSessionEffects: true,
            };
          }
          params.warn("failed to persist wedged subagent recovery marker", {
            runId: params.runId,
            childSessionKey,
            error,
          });
        }
      }
      params.warn("subagent restart recovery is blocked", {
        runId: params.runId,
        childSessionKey,
        reason: blockedReason,
      });
      return { status: "handled" };
    }
    if (!params.gatewayRuntime) {
      return { status: "deferred" };
    }

    const messages = await readSessionMessagesAsync(
      {
        agentId,
        sessionEntry,
        sessionId: sessionEntry.sessionId,
        sessionKey: childSessionKey,
        storePath,
      },
      { mode: "recent", maxMessages: 200, maxBytes: 1024 * 1024 },
    );
    if (!isRecoverySourceCurrent()) {
      return { status: "handled" };
    }
    const lastHumanMessage = extractSessionTranscriptText(
      [...messages].toReversed().find((message) => extractMessageRole(message) === "user"),
    );
    const configChanged = messages.some(
      (message) =>
        extractMessageRole(message) === "assistant" &&
        /openclaw\.json|openclaw gateway restart|config\.patch/i.test(
          extractSessionTranscriptText(message) ?? "",
        ),
    );
    const sessionId = sessionEntry.sessionId;
    const updatedAt = sessionEntry.updatedAt;
    if (!sessionId || typeof updatedAt !== "number") {
      return {
        status: "retry",
        error: "subagent restart recovery session snapshot is incomplete",
      };
    }
    const assertSnapshotCurrent = () => {
      if (!isRecoverySourceCurrent()) {
        throw new Error("subagent restart recovery source changed before dispatch");
      }
      assertRestartRecoverySnapshotCurrent({
        childSessionKey,
        isOwnerCurrent: isRecoverySourceCurrent,
        sessionId,
        sessionLifecycleRevision: sessionEntry.lifecycleRevision,
        storePath,
        updatedAt,
      });
    };
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: assertSnapshotCurrent,
      revalidateAllowed: assertSnapshotCurrent,
    });
    const handoffId = admission.createHandoff();
    let idempotencyKey = "";
    let dispatched: { runId: string; status: unknown } | undefined;
    let dispatchFailure: { error: unknown } | undefined;
    let earlyResult: RestartRecoveryResult | undefined;
    let attemptedGeneration: string | undefined;
    try {
      idempotencyKey =
        params.reserveLaunch({
          runId: params.runId,
          expected: params.entry,
          sessionId,
          sessionMarker: marker,
          sessionLifecycleRevision: sessionEntry.lifecycleRevision,
          idempotencyKey: buildRestartRecoveryIdempotencyKey(params.runId, marker),
        }) ?? "";
      if (!idempotencyKey) {
        earlyResult = { status: "handled" };
      } else {
        const attempted = params.markLaunchAttempted({
          runId: params.runId,
          expected: params.entry,
          sessionMarker: marker,
          idempotencyKey,
          lifecycleGeneration: recoveryLifecycleGeneration,
        });
        if (!attempted || attempted.phase === "accepted") {
          earlyResult = { status: "handled" };
        } else {
          attemptedGeneration = attempted.lifecycleGeneration;
          dispatched = await admission.run(() =>
            params.gatewayRuntime!.dispatchAgent<{ runId: string; status: unknown }>({
              message:
                buildRestartRecoveryResumeMessage(
                  params.entry.task,
                  lastHumanMessage ?? undefined,
                ) +
                (configChanged
                  ? "\n\n[config changes from your previous run were already applied — do not re-modify openclaw.json or restart the gateway]"
                  : ""),
              sessionKey: childSessionKey,
              expectedExistingSessionId: sessionId,
              internalRuntimeHandoffId: handoffId,
              idempotencyKey,
              deliver: false,
              lane: "subagent",
              ...(params.entry.collect
                ? { swarmCollector: true, swarmOutputSchema: params.entry.outputSchema }
                : {}),
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: params.entry.requesterSessionKey,
                sourceChannel: "internal",
                sourceTool: "subagent_interrupted_resume",
              },
              sessionEffects: "internal",
              suppressPromptPersistence: true,
            }),
          );
        }
      }
    } catch (error) {
      dispatchFailure = { error };
    }
    const handoffCanceled = cancelSessionWorkAdmissionHandoff(handoffId);
    const attemptedLifecycleRetired =
      attemptedGeneration !== undefined &&
      !agentEvents.isAgentEventLifecycleGenerationCurrent(attemptedGeneration);
    if (attemptedGeneration) {
      if (handoffCanceled) {
        if (
          !params.resetLaunchAttempt({
            runId: params.runId,
            expected: params.entry,
            sessionMarker: marker,
            idempotencyKey,
          })
        ) {
          throw new Error("failed to reset unconsumed subagent restart recovery attempt");
        }
      } else {
        try {
          const consumed = params.markLaunchConsumed({
            runId: params.runId,
            expected: params.entry,
            sessionMarker: marker,
            idempotencyKey,
          });
          if (!consumed || consumed.phase === "reserved" || consumed.phase === "attempted") {
            throw new Error("failed to persist consumed subagent restart recovery attempt");
          }
        } catch (error) {
          if (!dispatched) {
            throw error;
          }
          params.warn(
            "subagent restart recovery could not persist its intermediate consumed receipt",
            {
              runId: params.runId,
              childSessionKey,
              error,
            },
          );
        }
      }
    }
    if (attemptedLifecycleRetired) {
      return handoffCanceled
        ? { status: "handled" }
        : {
            status: "terminal",
            error: "retired Gateway lifecycle",
            suppressSessionEffects: true,
          };
    }
    if (earlyResult) {
      return earlyResult;
    }
    if (dispatchFailure) {
      throw dispatchFailure.error;
    }
    if (handoffCanceled) {
      return {
        status: "retry",
        error: "Gateway did not consume the subagent restart recovery admission",
      };
    }
    if (!dispatched) {
      throw new Error("subagent restart recovery dispatch completed without a response");
    }
    if (
      dispatched.runId !== idempotencyKey ||
      (dispatched.status !== "accepted" && dispatched.status !== "in_flight")
    ) {
      if (
        !params.abandonLaunch({
          runId: params.runId,
          expected: params.entry,
          sessionMarker: marker,
          idempotencyKey,
        })
      ) {
        return {
          status: "retry",
          error: "rejected subagent restart recovery could not persist its terminal fence",
        };
      }
      return {
        status: "terminal",
        error:
          "Gateway did not accept the subagent restart recovery run; " +
          "automatic replay was suppressed to avoid duplicate side effects",
      };
    }
    const restartRecovery = params.markLaunchAccepted({
      runId: params.runId,
      expected: params.entry,
      sessionMarker: marker,
      idempotencyKey,
    });
    if (!restartRecovery || restartRecovery.phase !== "accepted") {
      return {
        status: "retry",
        error: "accepted subagent restart recovery could not persist its acceptance receipt",
      };
    }
    return await reconcileAcceptedRecovery({
      agentId,
      attempts,
      childSessionKey,
      currentSessionId: sessionId,
      currentSessionLifecycleRevision: sessionEntry.lifecycleRevision,
      clearAcceptedRecovery: params.clearAcceptedRecovery,
      entry: params.entry,
      getRun: params.getRun,
      isCurrent: params.isCurrent,
      now: Date.now(),
      receipt: restartRecovery,
      replaceRun: params.replaceRun,
      resumeAcceptedRecovery: params.resumeAcceptedRecovery,
      runId: params.runId,
      storePath,
      warn: params.warn,
    });
  } catch (error) {
    return { status: "retry", error: formatErrorMessage(error) };
  }
}
