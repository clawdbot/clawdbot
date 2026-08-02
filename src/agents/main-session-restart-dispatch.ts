import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import type { SessionEntry } from "../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  buildResumingSessionNoticeIdempotencyKey,
  resolveResumingSessionNoticeRunId,
} from "./main-session-restart-claim.js";

const log = createSubsystemLogger("main-session-restart-recovery");
const RESTART_RECOVERY_RESUME_MESSAGE =
  "[System] Your previous turn was interrupted by a gateway restart while " +
  "OpenClaw was waiting on tool/model work. Continue from the existing " +
  "transcript and finish the interrupted response.";
const RESTART_RECOVERY_RESUMING_NOTICE =
  "The gateway reset interrupted me. I'm resuming this work now.";

type RestartRecoveryTerminalStatus = "error" | "ok" | "timeout";

function normalizeFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
}): DeliveryContext | undefined {
  const activeRunDeliveryContext = normalizeDeliveryContext(
    params.entry.restartRecoveryDeliveryContext,
  );
  // A claim with no context is intentionally transcript-only. Only legacy
  // rows without a claim may fall back to the session delivery route.
  const hasActiveRunDeliveryClaim =
    normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId) !== undefined;
  const deliveryContext =
    normalizeDeliveryContext(params.entry.pendingFinalDeliveryContext) ??
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
): Promise<RestartRecoveryTerminalStatus | undefined> {
  try {
    const result = await callGateway<{ endedAt?: unknown; status?: unknown }>({
      method: "agent.wait",
      params: { runId, timeoutMs: 0 },
      timeoutMs: 2_000,
    });
    const status = normalizeRestartRecoveryTerminalStatus(result.status);
    // A zero-time wait also reports timeout for active or unknown work.
    return status === "timeout" && typeof result.endedAt !== "number" ? undefined : status;
  } catch {
    return undefined;
  }
}

async function sendRestartRecoveryResumingNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  noticeRunId: string;
  sessionKey: string;
}): Promise<void> {
  const messageParams: Record<string, unknown> = {
    to: params.deliveryContext.to,
    message: RESTART_RECOVERY_RESUMING_NOTICE,
    bestEffort: true,
  };
  if (params.deliveryContext.threadId != null) {
    messageParams.threadId = String(params.deliveryContext.threadId);
  }
  const actionParams: Record<string, unknown> = {
    channel: params.deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: buildResumingSessionNoticeIdempotencyKey(params.noticeRunId),
    params: messageParams,
  };
  const accountId = normalizeOptionalString(params.deliveryContext.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }

  try {
    await callGateway({
      method: "message.action",
      params: actionParams,
      timeoutMs: 10_000,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
    log.info(`sent gateway reset resuming notice: ${params.sessionKey}`);
  } catch (error) {
    // Recovery is the terminality contract. A failed courtesy notice must not
    // prevent the interrupted work from continuing.
    log.warn(`failed to send gateway reset resuming notice ${params.sessionKey}: ${String(error)}`);
  }
}

async function reserveRestartRecoveryResumingNotice(params: {
  entry: SessionEntry;
  recoveryRunId: string;
  sessionKey: string;
  sourceRunId?: string;
  storePath: string;
}): Promise<string | undefined> {
  return await applySessionEntryReplacements({
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (
        !entry ||
        entry.sessionId !== params.entry.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== params.recoveryRunId ||
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !== params.sourceRunId ||
        normalizeOptionalString(entry.restartRecoveryResumingNoticeRunId) !== undefined
      ) {
        return { result: undefined };
      }
      const noticeRunId = resolveResumingSessionNoticeRunId({
        entry,
        recoveryRunId: params.recoveryRunId,
      });
      entry.restartRecoveryResumingNoticeRunId = noticeRunId;
      entry.updatedAt = Date.now();
      return {
        result: noticeRunId,
        replacements: [{ sessionKey: params.sessionKey, entry }],
      };
    },
  });
}

async function settleRestartRecoveryDispatch(params: {
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  pendingFinalDeliveryText: string;
  sessionKeys: readonly string[];
  storePath: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<void> {
  await applySessionEntryReplacements({
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    update: (entries) => {
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
            terminalSourceRunId: params.expectedRecoverySourceRunId,
          }),
        );
      } else {
        entry.abortedLastRun = false;
      }
      entry.updatedAt = now;
      if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
        if (params.pendingFinalDeliveryText) {
          entry.pendingFinalDeliveryLastAttemptAt = now;
          entry.pendingFinalDeliveryAttemptCount =
            (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
          entry.pendingFinalDeliveryLastError = null;
          entry.pendingFinalDeliveryText = params.pendingFinalDeliveryText;
        } else {
          entry.pendingFinalDelivery = undefined;
          entry.pendingFinalDeliveryText = undefined;
          entry.pendingFinalDeliveryCreatedAt = undefined;
          entry.pendingFinalDeliveryLastAttemptAt = undefined;
          entry.pendingFinalDeliveryAttemptCount = undefined;
          entry.pendingFinalDeliveryLastError = undefined;
          entry.pendingFinalDeliveryContext = undefined;
        }
      }
      return {
        result: undefined,
        replacements: [{ sessionKey: current.sessionKey, entry }],
      };
    },
  });
}

export async function resumeMainSession(params: {
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  sessionWorkAdmissionHandoffId?: string;
}): Promise<boolean> {
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
  const recoveryRunId = claimedRunId && claimedRunId !== sourceRunId ? claimedRunId : randomUUID();
  const reusingRecoveryRunId = recoveryRunId === claimedRunId;
  const dispatchSessionKey = params.canonicalSessionKey ?? params.sessionKey;
  const recoverySessionKeys = Array.from(new Set([dispatchSessionKey, params.sessionKey]));
  try {
    // Persist one stable RPC id before dispatch. A transport rejection is
    // ambiguous; retries must reuse this id so accepted work cannot duplicate.
    const recoveryStatePrepared = await applySessionEntryReplacements({
      sessionKeys: [params.sessionKey],
      storePath: params.storePath,
      update: (entries) => {
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
      throw new Error("restart recovery session ownership changed before dispatch");
    }
    let resumingNoticeRunId: string | undefined;
    if (deliveryContext) {
      try {
        resumingNoticeRunId = await reserveRestartRecoveryResumingNotice({
          entry: params.entry,
          recoveryRunId,
          sessionKey: params.sessionKey,
          sourceRunId,
          storePath: params.storePath,
        });
      } catch (error) {
        // Courtesy-notice durability must never become a prerequisite for the
        // interrupted work's terminality path.
        log.warn(
          `failed to reserve gateway reset resuming notice ${params.sessionKey}: ${String(error)}`,
        );
      }
    }
    const resumingNoticePromise =
      deliveryContext && resumingNoticeRunId
        ? sendRestartRecoveryResumingNotice({
            deliveryContext,
            entry: params.entry,
            noticeRunId: resumingNoticeRunId,
            sessionKey: dispatchSessionKey,
          })
        : Promise.resolve();
    const agentParams: Record<string, unknown> = {
      message: buildResumeMessage(sanitizedPendingText),
      sessionKey: dispatchSessionKey,
      expectedExistingSessionId: params.entry.sessionId,
      ...(params.sessionWorkAdmissionHandoffId
        ? { internalRuntimeHandoffId: params.sessionWorkAdmissionHandoffId }
        : {}),
      idempotencyKey: recoveryRunId,
      deliver: Boolean(deliveryContext),
      lane: CommandLane.Main,
      ...(params.entry.restartRecoverySourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: params.entry.restartRecoverySourceReplyDeliveryMode }
        : {}),
      ...(params.forceRestartSafeTools ? { forceRestartSafeTools: true } : {}),
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
    if (params.forceRestartSafeTools) {
      log.info(`dispatching restart-safe recovery for ${params.sessionKey}`);
    }
    const dispatchPromise = callGateway<{ runId: string; status?: unknown }>({
      method: "agent",
      params: agentParams,
      timeoutMs: 10_000,
    });
    const [dispatchResult] = await Promise.all([dispatchPromise, resumingNoticePromise]);
    let terminalStatus = normalizeRestartRecoveryTerminalStatus(dispatchResult.status);
    if (!terminalStatus && reusingRecoveryRunId && dispatchResult.status === "accepted") {
      terminalStatus = await probeRestartRecoveryTerminalStatus(recoveryRunId);
    }
    await settleRestartRecoveryDispatch({
      expectedRecoveryRunId: recoveryRunId,
      expectedRecoverySourceRunId: sourceRunId,
      expectedSessionId: params.entry.sessionId,
      pendingFinalDeliveryText: sanitizedPendingText,
      sessionKeys: recoverySessionKeys,
      storePath: params.storePath,
      terminalStatus,
    });
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
      }`,
    );
    return true;
  } catch (error) {
    if (
      reusingRecoveryRunId &&
      error instanceof Error &&
      error.name === "GatewayClientRequestError"
    ) {
      const terminalStatus = await probeRestartRecoveryTerminalStatus(recoveryRunId);
      if (terminalStatus) {
        await settleRestartRecoveryDispatch({
          expectedRecoveryRunId: recoveryRunId,
          expectedRecoverySourceRunId: sourceRunId,
          expectedSessionId: params.entry.sessionId,
          pendingFinalDeliveryText: sanitizedPendingText,
          sessionKeys: recoverySessionKeys,
          storePath: params.storePath,
          terminalStatus,
        });
        log.info(`settled completed restart recovery for ${params.sessionKey}`);
        return true;
      }
    }
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(error)}`);
    return false;
  }
}
