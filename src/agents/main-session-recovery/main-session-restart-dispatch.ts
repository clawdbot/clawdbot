import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import { sanitizePendingFinalDeliveryText } from "../../auto-reply/reply/pending-final-delivery.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
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
import { TOOL_FAILURE_INSTRUCTION } from "../tool-outcome-instructions.js";
import { repairMainSessionRecoveryMutation } from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import type {
  MainSessionRecoveryObservation,
  MainSessionRecoveryReservation,
} from "./main-session-recovery-state.js";
import {
  commitMainSessionRecovery,
  createRestoreAdmittedRecoveryInterrupted,
} from "./main-session-recovery-store.js";
import {
  normalizeRestartRecoveryTerminalStatus,
  probeRestartRecoveryTerminalStatus,
  rollbackRestartRecoveryReservation,
  scheduleRestartRecoveryReservationRollback,
  settleAcceptedRestartRecovery,
} from "./main-session-restart-dispatch-settle.js";
import { dispatchRestartRecoveryUntilStarted } from "./main-session-restart-dispatch-start.js";

const log = createSubsystemLogger("main-session-restart-recovery");
const RESTART_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  "Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. Continue from the existing " +
    "transcript and finish the interrupted response. Treat a tool result marked interrupted or " +
    `missing as having an unknown outcome. ${TOOL_FAILURE_INSTRUCTION}`,
);

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

type MainSessionResumeResult = "started" | "settled" | "skipped" | "failed";

export async function resumeMainSession(params: {
  agentId: string;
  /** Durable SQLite owner partition for reads/writes. Defaults to the store's resolved owner when omitted. */
  dbAgentId?: string;
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
    includeSessionDeliveryFallback: true,
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
  const claimedRunWasAdmittedBeforeRestart =
    claimedRunId !== undefined &&
    params.entry.restartRecoveryRuns?.some(
      (run) => run.runId === claimedRunId && run.lifecycleGeneration !== lifecycleGeneration,
    ) === true;
  const recoveryRunId =
    claimedRunId && claimedRunId !== sourceRunId && !claimedRunWasAdmittedBeforeRestart
      ? claimedRunId
      : randomUUID();
  const reusingRecoveryRunId = recoveryRunId === claimedRunId;
  const dispatchSessionKey = params.canonicalSessionKey ?? params.sessionKey;
  const recoverySessionKeys = Array.from(new Set([dispatchSessionKey, params.sessionKey]));
  let reservation: MainSessionRecoveryReservation | undefined;
  let dispatchStarted = false;
  let dispatchAccepted = false;
  let executionStarted = false;
  let preStartAbortAttempted = false;
  let preStartAbortConfirmed = false;
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
      agentId: params.dbAgentId,
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
      agentId: params.dbAgentId,
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
      agentId: params.dbAgentId,
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
        entry.restartRecoveryForceSafeTools = params.forceRestartSafeTools ? true : undefined;
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
    const dispatchOutcome = await dispatchRestartRecoveryUntilStarted({
      agentParams,
      gatewayRuntime: params.gatewayRuntime,
    });
    ({ dispatchAccepted, executionStarted, preStartAbortAttempted, preStartAbortConfirmed } =
      dispatchOutcome.observation);
    if (dispatchOutcome.kind === "failed") {
      throw dispatchOutcome.error;
    }
    const dispatchResult =
      dispatchOutcome.kind === "terminal"
        ? dispatchOutcome.result
        : { runId: recoveryRunId, status: "accepted" };
    if (params.shouldContinue?.() === false) {
      // The accepted run belongs to its original Gateway; never let a stopped
      // owner settle or transfer that durable claim into a new lifecycle.
      return "skipped";
    }
    // Real Gateway admission consumes the reservation before returning accepted.
    // Recovery-runtime fakes may return directly, so keep this idempotent fallback
    // to make the durable acceptance boundary explicit in focused tests too.
    let terminalStatus = normalizeRestartRecoveryTerminalStatus(dispatchResult.status);
    if (
      !executionStarted &&
      !terminalStatus &&
      reusingRecoveryRunId &&
      dispatchResult.status === "accepted"
    ) {
      terminalStatus = await probeRestartRecoveryTerminalStatus(
        recoveryRunId,
        params.gatewayRuntime,
      );
    }
    if (!executionStarted && !terminalStatus) {
      throw new Error(
        `restart recovery dispatch ended before execution started: ${params.sessionKey}`,
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
        agentId: params.dbAgentId,
        terminalStatus,
      }))
    ) {
      throw new Error(`restart recovery admission changed before settlement: ${params.sessionKey}`);
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    const resumeResult = terminalStatus ? "settled" : "started";
    log.info(
      `${resumeResult} interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
      }`,
    );
    return resumeResult;
  } catch (error) {
    const explicitlyRejected = error instanceof GatewayClientRequestError && !dispatchAccepted;
    const canRestoreAcceptedFailure = !preStartAbortAttempted || preStartAbortConfirmed;
    if (
      dispatchAccepted &&
      !executionStarted &&
      canRestoreAcceptedFailure &&
      params.shouldContinue?.() !== false
    ) {
      // Resolve the trajectory target before opening the restore transaction:
      // filesystem/registry inspection must not run while the session write
      // lock is held. A resolver failure leaves the admitted row to the normal
      // startup-orphan recovery path instead of throwing past the rollback.
      let restoreAdmittedRecovery:
        | ReturnType<typeof createRestoreAdmittedRecoveryInterrupted>
        | undefined;
      try {
        restoreAdmittedRecovery = createRestoreAdmittedRecoveryInterrupted({
          agentId: params.dbAgentId ?? params.agentId,
          lifecycleGeneration,
          logWarn: (message) => log.warn(message),
          runId: recoveryRunId,
          sessionId: () => params.entry.sessionId,
          sessionKey: params.sessionKey,
          shouldContinue: params.shouldContinue,
          storePath: params.storePath,
          trajectoryTarget: resolveSqliteTargetFromSessionStorePath(params.storePath, {
            agentId: params.dbAgentId ?? params.agentId,
          }),
        });
      } catch (resolveError) {
        log.warn(
          `failed to resolve trajectory target for accepted restart recovery ${params.sessionKey}: ${String(resolveError)}`,
        );
        restoreAdmittedRecovery = undefined;
      }
      const restored = restoreAdmittedRecovery
        ? await repairMainSessionRecoveryMutation({
            mutation: restoreAdmittedRecovery,
            onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
            onError: (restoreError) => {
              if (params.shouldContinue?.() !== false) {
                log.warn(
                  `failed to restore accepted restart recovery ${params.sessionKey}: ${String(restoreError)}`,
                );
              }
            },
          })
        : undefined;
      if (params.shouldContinue?.() !== false) {
        scheduleMainSessionRecoveryPendingTarget(restored);
      }
    } else if (
      dispatchAccepted &&
      !executionStarted &&
      preStartAbortAttempted &&
      !preStartAbortConfirmed &&
      params.shouldContinue?.() !== false
    ) {
      log.warn(
        `restart recovery execution start timed out without confirmed cancellation: ${params.sessionKey}`,
      );
    }
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
            agentId: params.dbAgentId,
            terminalStatus,
          });
          if (!settled) {
            log.warn(`restart recovery admission changed before settlement: ${params.sessionKey}`);
          } else if (params.shouldContinue?.() !== false) {
            log.info(`observed terminal restart recovery for ${params.sessionKey}`);
            return "settled";
          }
        }
      }
    } catch (settlementError) {
      if (params.shouldContinue?.() !== false) {
        log.warn(
          `failed to settle ambiguous restart recovery ${params.sessionKey}: ${String(settlementError)}`,
        );
        // Resolve the trajectory target inside this recovery path only: a
        // resolver failure must not throw past the settlement catch and skip
        // the reservation rollback below. Without a resolved target the
        // admitted row keeps its normal startup-orphan recovery path.
        let restoreAdmittedRecovery:
          | ReturnType<typeof createRestoreAdmittedRecoveryInterrupted>
          | undefined;
        try {
          restoreAdmittedRecovery = createRestoreAdmittedRecoveryInterrupted({
            agentId: params.dbAgentId ?? params.agentId,
            lifecycleGeneration,
            logWarn: (message) => log.warn(message),
            runId: recoveryRunId,
            sessionId: () => params.entry.sessionId,
            sessionKey: params.sessionKey,
            shouldContinue: params.shouldContinue,
            storePath: params.storePath,
            trajectoryTarget: resolveSqliteTargetFromSessionStorePath(params.storePath, {
              agentId: params.dbAgentId ?? params.agentId,
            }),
          });
        } catch (resolveError) {
          log.warn(
            `failed to resolve trajectory target for ambiguous restart recovery ${params.sessionKey}: ${String(resolveError)}`,
          );
          restoreAdmittedRecovery = undefined;
        }
        const restored = restoreAdmittedRecovery
          ? await repairMainSessionRecoveryMutation({
              mutation: restoreAdmittedRecovery,
              onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
              onError: (restoreError) => {
                if (params.shouldContinue?.() !== false) {
                  log.warn(
                    `failed to restore ambiguous restart recovery ${params.sessionKey}: ${String(restoreError)}`,
                  );
                }
              },
            })
          : undefined;
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
          agentId: params.dbAgentId,
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
