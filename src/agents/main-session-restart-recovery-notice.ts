import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { resolveDefaultAgentId } from "./agent-scope-config.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { buildUnresumableSessionNoticeIdempotencyKey } from "./main-session-restart-claim.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-dispatch.js";
import { log, UNRESUMABLE_SESSION_NOTICE } from "./main-session-restart-recovery-shared.js";

async function markSessionFailed(params: {
  observation: MainSessionRecoveryObservation;
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<boolean> {
  const marked = await commitMainSessionRecovery({
    command: {
      kind: "fail_recovery",
      now: Date.now(),
      observation: params.observation,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (marked.transition.kind === "failed") {
    log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
    return true;
  }
  return false;
}

async function sendUnresumableSessionNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  reason: string;
  sessionKey: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<void> {
  const messageParams: Record<string, unknown> = {
    to: params.deliveryContext.to,
    message: UNRESUMABLE_SESSION_NOTICE,
    bestEffort: true,
  };
  if (params.deliveryContext.threadId != null) {
    messageParams.threadId = params.deliveryContext.threadId;
  }
  const actionParams: Record<string, unknown> = {
    channel: params.deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
    params: messageParams,
  };
  const accountId = normalizeOptionalString(params.deliveryContext.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }

  try {
    await params.gatewayRuntime.sendRecoveryNotice(actionParams, 10_000);
    log.info(
      `sent interrupted main session recovery notice: ${params.sessionKey} (${params.reason})`,
    );
  } catch (err) {
    log.warn(
      `failed to send interrupted main session recovery notice ${params.sessionKey}: ${String(err)}`,
    );
  }
}

async function writeUnresumableSessionNotice(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<boolean> {
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    expectedSessionId: params.entry.sessionId,
    expectedSessionState: {
      abortedLastRun: params.entry.abortedLastRun,
      restartRecoveryBeforeAgentReplyState: params.entry.restartRecoveryBeforeAgentReplyState,
      restartRecoveryDeliveryReceiptState: params.entry.restartRecoveryDeliveryReceiptState,
      restartRecoveryDeliveryToolCallId: params.entry.restartRecoveryDeliveryToolCallId,
      restartRecoveryDeliveryRequestFingerprint:
        params.entry.restartRecoveryDeliveryRequestFingerprint,
      restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryRequesterAccountId: params.entry.restartRecoveryRequesterAccountId,
      restartRecoveryRequesterSenderId: params.entry.restartRecoveryRequesterSenderId,
      restartRecoverySameChannelThreadRequired:
        params.entry.restartRecoverySameChannelThreadRequired,
      restartRecoverySourceIngress: params.entry.restartRecoverySourceIngress,
      restartRecoverySourceReplyDeliveryMode: params.entry.restartRecoverySourceReplyDeliveryMode,
      restartRecoveryTerminalRunIds: params.entry.restartRecoveryTerminalRunIds,
      status: params.entry.status,
      updatedAt: params.entry.updatedAt,
    },
    storePath: params.storePath,
    text: UNRESUMABLE_SESSION_NOTICE,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    log.warn(
      `failed to write interrupted main session notice ${params.sessionKey}: ${result.reason}`,
    );
  }
  return result.ok;
}

export async function failUnresumableMainSession(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  observation: MainSessionRecoveryObservation;
  reason: string;
  sessionKey: string;
  storePath: string;
}): Promise<"failed" | "skipped"> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (
    !deliveryContext &&
    !(await writeUnresumableSessionNotice({
      agentId: resolveAgentIdFromSessionKey(
        params.sessionKey,
        params.cfg ? resolveDefaultAgentId(params.cfg) : undefined,
      ),
      entry: params.entry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    }))
  ) {
    // Keep ownership for another recovery attempt until its terminal notice is durable.
    return "failed";
  }
  const marked = await markSessionFailed({
    observation: params.observation,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    reason: params.reason,
  });
  if (!marked) {
    return "skipped";
  }
  if (deliveryContext) {
    await sendUnresumableSessionNotice({
      deliveryContext,
      entry: params.entry,
      gatewayRuntime: params.gatewayRuntime,
      reason: params.reason,
      sessionKey: params.sessionKey,
    });
  }
  return "failed";
}
