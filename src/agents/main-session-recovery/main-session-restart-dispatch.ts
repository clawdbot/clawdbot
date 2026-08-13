import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import { sanitizePendingFinalDeliveryText } from "../../auto-reply/reply/pending-final-delivery.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  hasRestartRecoveryTerminalRun,
  resolveRestartRecoveryChannelAuthority,
} from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isTrustedMessageActionTurnIngress } from "../../gateway/message-action-turn-capability.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CommandLane } from "../../process/lanes.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import {
  repairMainSessionRecoveryMutation,
  retryMainSessionRecoveryMutation,
  scheduleMainSessionRecoveryMutation,
} from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import {
  isMainSessionRecoveryPending,
  type MainSessionRecoveryObservation,
  type MainSessionRecoveryReservation,
} from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { normalizeFiniteTimestamp } from "./main-session-restart-recovery-shared.js";

const log = createSubsystemLogger("main-session-restart-recovery");
const RESTART_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  "Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. Continue from the existing " +
    "transcript and finish the interrupted response.",
);

type RestartRecoveryTerminalStatus = "error" | "ok" | "timeout";

export function hasRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  const authority = resolveRestartRecoveryChannelAuthority(entry);
  // Keep the pre-dispatch gate identical to recovered capability minting.
  return (
    authority !== undefined && isTrustedMessageActionTurnIngress(authority.deliveryContext.channel)
  );
}

/** Internal continuations never inherit channel authority; every other message-tool recovery must. */
export function requiresRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  return (
    entry.restartRecoverySourceReplyDeliveryMode === "message_tool_only" &&
    entry.restartRecoverySourceIngress !== "internal"
  );
}

function buildResumeMessage(pendingFinalDeliveryText?: string | null): string {
  const sanitizedPendingText =
    typeof pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(pendingFinalDeliveryText)
      : "";
  if (sanitizedPendingText) {
    return `${RESTART_RECOVERY_RESUME_MESSAGE}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`;
  }
  return RESTART_RECOVERY_RESUME_MESSAGE;
}

export function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  includeSessionDeliveryFallback?: boolean;
  sessionKey: string;
}): (DeliveryContext & { channel: string; to: string }) | undefined {
  const activeRunDeliveryContext = normalizeDeliveryContext(
    params.entry.restartRecoveryDeliveryContext,
  );
  // A claim with no context is intentionally transcript-only. Only legacy
  // rows without a claim may fall back to the session delivery route.
  const hasActiveRunDeliveryClaim =
    normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId) !== undefined;
  const deliveryContext =
    normalizeDeliveryContext(params.entry.pendingFinalDelivery?.context) ??
    activeRunDeliveryContext ??
    (params.includeSessionDeliveryFallback && !hasActiveRunDeliveryClaim
      ? deliveryContextFromSession(params.entry)
      : undefined);
  const channel = normalizeOptionalString(deliveryContext?.channel);
  const to = normalizeOptionalString(deliveryContext?.to);
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  if (
    params.cfg &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: params.entry,
      sessionKey: params.sessionKey,
      channel,
      chatType: params.entry.chatType,
    }) === "deny"
  ) {
    return undefined;
  }
  return { ...deliveryContext, channel, to };
}

function normalizeRestartRecoveryTerminalStatus(
  value: unknown,
): RestartRecoveryTerminalStatus | undefined {
  return value === "error" || value === "ok" || value === "timeout" ? value : undefined;
}

async function probeRestartRecoveryTerminalStatus(
  runId: string,
  gatewayRuntime: GatewayRecoveryRuntime,
): Promise<RestartRecoveryTerminalStatus | undefined> {
  try {
    const result = await gatewayRuntime.waitForAgent<{ endedAt?: unknown; status?: unknown }>(
      { runId, timeoutMs: 0 },
      2_000,
    );
    const status = normalizeRestartRecoveryTerminalStatus(result.status);
    // A zero-time wait also reports timeout for active or unknown work.
    return status === "timeout" && typeof result.endedAt !== "number" ? undefined : status;
  } catch {
    return undefined;
  }
}

async function settleRestartRecoveryDispatch(params: {
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  sessionKeys: readonly string[];
  shouldContinue?: () => boolean;
  storePath: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<void> {
  await applySessionEntryReplacements({
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    update: (entries) => {
      if (params.shouldContinue?.() === false) {
        return { result: undefined };
      }
      const current = entries
        .filter(
          ({ entry }) =>
            entry.sessionId === params.expectedSessionId &&
            normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ===
              params.expectedRecoveryRunId &&
            normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
              params.expectedRecoverySourceRunId,
        )
        .toSorted((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))[0];
      if (!current) {
        return { result: undefined };
      }
      const entry = current.entry;
      const now = Date.now();
      if (params.terminalStatus) {
        entry.abortedLastRun = params.terminalStatus !== "ok";
        entry.status =
          params.terminalStatus === "ok"
            ? "done"
            : params.terminalStatus === "timeout"
              ? "timeout"
              : "failed";
        entry.endedAt = now;
        const startedAt = normalizeFiniteTimestamp(entry.startedAt);
        if (startedAt !== undefined) {
          entry.runtimeMs = Math.max(0, now - startedAt);
        }
        entry.restartRecoveryForceSafeTools = undefined;
        Object.assign(
          entry,
          buildRestartRecoveryClaimCleanupPatch({
            entry,
            recordTerminalSource: true,
            terminalRunId: params.expectedRecoveryRunId,
            terminalSourceRunId: params.expectedRecoverySourceRunId,
          }),
          buildMainSessionRecoveryClearPatch(entry),
        );
      } else {
        entry.abortedLastRun = false;
      }
      entry.updatedAt = now;
      return {
        result: undefined,
        replacements: [{ sessionKey: current.sessionKey, entry }],
      };
    },
  });
}

function isExactRestartRecoveryDispatchAdmission(params: {
  admission: Awaited<ReturnType<typeof commitMainSessionRecovery>>;
  lifecycleGeneration: string;
  recoveryRunId: string;
  sessionId: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): boolean {
  const entry = params.admission.entry;
  return (
    entry?.sessionId === params.sessionId &&
    ((entry.abortedLastRun === false &&
      normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === params.recoveryRunId &&
      entry.restartRecoveryRuns?.some(
        (run) =>
          run.runId === params.recoveryRunId &&
          run.lifecycleGeneration === params.lifecycleGeneration,
      ) === true) ||
      (hasRestartRecoveryTerminalRun(entry, params.recoveryRunId) &&
        ((params.terminalStatus === "ok" && entry.status === "done") ||
          (params.terminalStatus === "error" && entry.status === "failed") ||
          (params.terminalStatus === "timeout" && entry.status === "timeout"))))
  );
}

async function settleAcceptedRestartRecovery(params: {
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  lifecycleGeneration: string;
  reservation?: MainSessionRecoveryReservation;
  sessionKey: string;
  sessionKeys: readonly string[];
  shouldContinue?: () => boolean;
  storePath: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<boolean> {
  const admission = await commitMainSessionRecovery({
    command: {
      kind: "admit_recovery",
      lifecycleGeneration: params.lifecycleGeneration,
      now: Date.now(),
      runId: params.expectedRecoveryRunId,
      sessionId: params.expectedSessionId,
    },
    shouldContinue: params.shouldContinue,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (
    admission.transition.kind !== "admitted_recovery" &&
    !isExactRestartRecoveryDispatchAdmission({
      admission,
      lifecycleGeneration: params.lifecycleGeneration,
      recoveryRunId: params.expectedRecoveryRunId,
      sessionId: params.expectedSessionId,
      terminalStatus: params.terminalStatus,
    })
  ) {
    return false;
  }
  if (params.shouldContinue?.() === false) {
    return true;
  }
  if (params.reservation) {
    await commitMainSessionRecovery({
      command: { kind: "abandon_reservation", reservation: params.reservation },
      target: { sessionKey: params.sessionKey, storePath: params.storePath },
    });
  }
  if (params.shouldContinue?.() !== false) {
    await settleRestartRecoveryDispatch(params);
  }
  return true;
}

type MainSessionResumeResult = "resumed" | "skipped" | "failed";

async function rollbackRestartRecoveryReservation(params: {
  kind: "abandon_reservation" | "cancel_reservation";
  reservation: MainSessionRecoveryReservation;
  sessionKey: string;
  storePath: string;
}) {
  return await retryMainSessionRecoveryMutation(async () =>
    commitMainSessionRecovery({
      command: { kind: params.kind, reservation: params.reservation },
      requireWriteSuccess: true,
      target: { sessionKey: params.sessionKey, storePath: params.storePath },
    }),
  );
}

function scheduleRestartRecoveryReservationRollback(
  params: Parameters<typeof rollbackRestartRecoveryReservation>[0],
): void {
  // Keep the exact reservation token alive after transient store outages.
  // A Gateway restart safely retires the timer and its stale-generation slot.
  scheduleMainSessionRecoveryMutation({
    mutation: () => rollbackRestartRecoveryReservation(params),
    onError: (error) => {
      log.warn(
        `failed delayed restart recovery reservation rollback ${params.sessionKey}: ${String(error)}`,
      );
    },
    onSuccess: ({ entry, sessionKey }) => {
      if (
        entry?.sessionId === params.reservation.sessionId &&
        sessionKey &&
        isMainSessionRecoveryPending(entry, sessionKey)
      ) {
        scheduleMainSessionRecoveryPendingTarget({
          sessionId: entry.sessionId,
          sessionKey,
          storePath: params.storePath,
        });
      }
    },
  });
}

export async function resumeMainSession(params: {
  agentId: string;
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  recoveryAttempt: number;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  sessionWorkAdmissionHandoffId?: string;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<MainSessionResumeResult> {
  if (params.shouldContinue?.() === false) {
    return "skipped";
  }
  const lifecycleGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const sanitizedPendingText =
    typeof params.pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(params.pendingFinalDeliveryText)
      : "";
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    sessionKey: params.sessionKey,
  });
  const claimedRunId = normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId);
  const sourceRunId = normalizeOptionalString(params.entry.restartRecoveryDeliverySourceRunId);
  if (
    requiresRestartRecoveryMessageActionAuthority(params.entry) &&
    !hasRestartRecoveryMessageActionAuthority(params.entry)
  ) {
    log.warn(`refusing message-tool-only recovery without channel authority: ${params.sessionKey}`);
    return "failed";
  }
  const recoveryRunId = claimedRunId && claimedRunId !== sourceRunId ? claimedRunId : randomUUID();
  const reusingRecoveryRunId = recoveryRunId === claimedRunId;
  const dispatchSessionKey = params.canonicalSessionKey ?? params.sessionKey;
  const recoverySessionKeys = Array.from(new Set([dispatchSessionKey, params.sessionKey]));
  let reservation: MainSessionRecoveryReservation | undefined;
  let dispatchStarted = false;
  const rollbackReservation = async (kind: "abandon_reservation" | "cancel_reservation") => {
    if (!reservation) {
      return undefined;
    }
    const current = reservation;
    const result = await rollbackRestartRecoveryReservation({
      kind,
      reservation: current,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    reservation = undefined;
    return { current, result };
  };
  try {
    const reserved = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: params.recoveryAttempt,
        lifecycleGeneration,
        now: Date.now(),
        observation: params.observation,
        runId: recoveryRunId,
        executionIdentity: isExecutionIdentityCollectionEnabled(params.cfg)
          ? { state: "enabled" }
          : { state: "disabled" },
      },
      requireWriteSuccess: true,
      shouldContinue: params.shouldContinue,
      target: { sessionKey: params.sessionKey, storePath: params.storePath },
    });
    if (reserved.transition.kind !== "reserved") {
      return "skipped";
    }
    reservation = reserved.transition.reservation;
    if (params.shouldContinue?.() === false) {
      await rollbackReservation("cancel_reservation");
      return "skipped";
    }
    // Persist one stable RPC id before dispatch. A transport rejection is
    // ambiguous; retries must reuse this id so accepted work cannot duplicate.
    const recoveryStatePrepared = await applySessionEntryReplacements({
      sessionKeys: [params.sessionKey],
      storePath: params.storePath,
      update: (entries) => {
        if (params.shouldContinue?.() === false) {
          return { result: false };
        }
        const current = entries.find((entry) => entry.sessionKey === params.sessionKey);
        const entry = current?.entry;
        if (
          !entry ||
          entry.sessionId !== params.entry.sessionId ||
          entry.status !== "running" ||
          entry.abortedLastRun !== true ||
          normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== claimedRunId ||
          normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !== sourceRunId
        ) {
          return { result: false };
        }
        entry.restartRecoveryDeliveryRunId = recoveryRunId;
        if (params.forceRestartSafeTools) {
          entry.restartRecoveryForceSafeTools = true;
        }
        entry.updatedAt = Date.now();
        return {
          result: true,
          replacements: [{ sessionKey: params.sessionKey, entry }],
        };
      },
    });
    if (!recoveryStatePrepared) {
      const rollback = await rollbackReservation("cancel_reservation");
      if (params.shouldContinue?.() === false) {
        return "skipped";
      }
      const current = rollback?.result.entry;
      return current?.sessionId === params.entry.sessionId &&
        current.status === "running" &&
        current.abortedLastRun === true &&
        !current.mainRestartRecovery?.reservation &&
        !current.mainRestartRecovery?.tombstone
        ? "failed"
        : "skipped";
    }
    const agentParams: AgentRunRequest = {
      agentId: params.agentId,
      message: buildResumeMessage(sanitizedPendingText),
      sessionKey: dispatchSessionKey,
      expectedExistingSessionId: params.entry.sessionId,
      ...(params.sessionWorkAdmissionHandoffId
        ? { internalRuntimeHandoffId: params.sessionWorkAdmissionHandoffId }
        : {}),
      ...(isExecutionIdentityCollectionEnabled(params.cfg)
        ? { internalExecutionIdentityRetry: params.recoveryAttempt > 1 }
        : {}),
      internalExecutionIdentityRecoveryAttempt: params.recoveryAttempt,
      idempotencyKey: recoveryRunId,
      deliver:
        Boolean(deliveryContext) &&
        params.entry.restartRecoverySourceReplyDeliveryMode !== "message_tool_only",
      lane: CommandLane.Main,
      ...(params.entry.restartRecoverySourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: params.entry.restartRecoverySourceReplyDeliveryMode }
        : {}),
      ...(params.forceRestartSafeTools ? { forceRestartSafeTools: true } : {}),
      ...(params.forceCodeModeTools ? { forceCodeModeTools: true } : {}),
      inputProvenance: {
        kind: "internal_system",
        sourceSessionKey: dispatchSessionKey,
        sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
      },
    };
    if (deliveryContext) {
      agentParams.channel = deliveryContext.channel;
      agentParams.to = deliveryContext.to;
      agentParams.bestEffortDeliver = true;
      if (deliveryContext.accountId) {
        agentParams.accountId = deliveryContext.accountId;
      }
      if (deliveryContext.threadId != null) {
        agentParams.threadId = String(deliveryContext.threadId);
      }
    }
    if (params.shouldContinue?.() === false) {
      await rollbackReservation("cancel_reservation");
      return "skipped";
    }
    if (params.forceRestartSafeTools) {
      log.info(`dispatching restart-safe recovery for ${params.sessionKey}`);
    }
    dispatchStarted = true;
    const dispatchResult = await params.gatewayRuntime.dispatchAgent<{
      runId: string;
      status?: unknown;
    }>(agentParams, 10_000);
    if (params.shouldContinue?.() === false) {
      // The accepted run belongs to its original Gateway; never let a stopped
      // owner settle or transfer that durable claim into a new lifecycle.
      return "skipped";
    }
    // Real Gateway admission consumes the reservation before returning accepted.
    // Recovery-runtime fakes may return directly, so keep this idempotent fallback
    // to make the durable acceptance boundary explicit in focused tests too.
    let terminalStatus = normalizeRestartRecoveryTerminalStatus(dispatchResult.status);
    if (!terminalStatus && reusingRecoveryRunId && dispatchResult.status === "accepted") {
      terminalStatus = await probeRestartRecoveryTerminalStatus(
        recoveryRunId,
        params.gatewayRuntime,
      );
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    if (
      !(await settleAcceptedRestartRecovery({
        expectedRecoveryRunId: recoveryRunId,
        expectedRecoverySourceRunId: sourceRunId,
        expectedSessionId: params.entry.sessionId,
        lifecycleGeneration,
        sessionKey: params.sessionKey,
        sessionKeys: recoverySessionKeys,
        shouldContinue: params.shouldContinue,
        storePath: params.storePath,
        terminalStatus,
      }))
    ) {
      throw new Error(`restart recovery admission changed before settlement: ${params.sessionKey}`);
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
      }`,
    );
    return "resumed";
  } catch (error) {
    const explicitlyRejected = error instanceof GatewayClientRequestError;
    try {
      if (dispatchStarted && !explicitlyRejected && params.shouldContinue?.() !== false) {
        const terminalStatus = await probeRestartRecoveryTerminalStatus(
          recoveryRunId,
          params.gatewayRuntime,
        );
        if (terminalStatus && params.shouldContinue?.() !== false) {
          const settled = await settleAcceptedRestartRecovery({
            expectedRecoveryRunId: recoveryRunId,
            expectedRecoverySourceRunId: sourceRunId,
            expectedSessionId: params.entry.sessionId,
            lifecycleGeneration,
            reservation,
            sessionKey: params.sessionKey,
            sessionKeys: recoverySessionKeys,
            shouldContinue: params.shouldContinue,
            storePath: params.storePath,
            terminalStatus,
          });
          if (!settled) {
            log.warn(`restart recovery admission changed before settlement: ${params.sessionKey}`);
          } else if (params.shouldContinue?.() !== false) {
            log.info(`settled completed restart recovery for ${params.sessionKey}`);
            return "resumed";
          }
        }
      }
    } catch (settlementError) {
      if (params.shouldContinue?.() !== false) {
        log.warn(
          `failed to settle ambiguous restart recovery ${params.sessionKey}: ${String(settlementError)}`,
        );
        const restoreAdmittedRecovery = async () => {
          if (params.shouldContinue?.() === false) {
            return undefined;
          }
          const restored = await commitMainSessionRecovery({
            command: {
              kind: "mark_admitted_recovery_interrupted",
              lifecycleGeneration,
              now: Date.now(),
              runId: recoveryRunId,
              sessionId: params.entry.sessionId,
            },
            requireWriteSuccess: true,
            shouldContinue: params.shouldContinue,
            target: { sessionKey: params.sessionKey, storePath: params.storePath },
          });
          return params.shouldContinue?.() !== false &&
            restored.transition.kind === "applied" &&
            restored.entry &&
            restored.sessionKey
            ? {
                sessionId: restored.entry.sessionId,
                sessionKey: restored.sessionKey,
                storePath: params.storePath,
              }
            : undefined;
        };
        const restored = await repairMainSessionRecoveryMutation({
          mutation: restoreAdmittedRecovery,
          onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
          onError: (restoreError) => {
            if (params.shouldContinue?.() !== false) {
              log.warn(
                `failed to restore ambiguous restart recovery ${params.sessionKey}: ${String(restoreError)}`,
              );
            }
          },
        });
        if (params.shouldContinue?.() !== false) {
          scheduleMainSessionRecoveryPendingTarget(restored);
        }
      }
    }
    if (reservation) {
      const rollbackKind =
        dispatchStarted && !explicitlyRejected ? "abandon_reservation" : "cancel_reservation";
      await rollbackReservation(rollbackKind).catch((rollbackError: unknown) => {
        log.warn(
          `failed to roll back interrupted main session recovery attempt ${params.sessionKey}: ${String(rollbackError)}`,
        );
        scheduleRestartRecoveryReservationRollback({
          kind: rollbackKind,
          reservation: reservation!,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
      });
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    log.warn(
      `failed to resume interrupted main session ${params.sessionKey}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return "failed";
  }
}
