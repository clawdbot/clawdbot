import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../config/sessions/session-accessor.js";
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
import {
  buildRestartRecoveryExpectedState,
  log,
  UNRESUMABLE_SESSION_NOTICE,
} from "./main-session-restart-recovery-shared.js";

export async function sendUnresumableSessionNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  reason: string;
  sessionKey: string;
  text: string;
}): Promise<void> {
  const messageParams: Record<string, unknown> = {
    to: params.deliveryContext.to,
    message: params.text,
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

export async function writeUnresumableSessionNotice(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  text?: string;
}): Promise<"failed" | "stale" | "written"> {
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    expectedSessionId: params.entry.sessionId,
    expectedSessionState:
      params.expectedSessionState ?? buildRestartRecoveryExpectedState(params.entry),
    sessionLifecyclePatch: params.sessionLifecyclePatch,
    storePath: params.storePath,
    text: params.text ?? UNRESUMABLE_SESSION_NOTICE,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    log.warn(
      `failed to write interrupted main session notice ${params.sessionKey}: ${result.reason}`,
    );
  }
  return result.ok
    ? "written"
    : "code" in result && result.code === "session-rebound"
      ? "stale"
      : "failed";
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
    (await writeUnresumableSessionNotice({
      agentId: resolveAgentIdFromSessionKey(
        params.sessionKey,
        params.cfg ? resolveDefaultAgentId(params.cfg) : undefined,
      ),
      entry: params.entry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    })) !== "written"
  ) {
    // Keep ownership for another recovery attempt until its terminal notice is durable.
    return "failed";
  }
  const marked = await commitMainSessionRecovery({
    command: { kind: "fail_recovery", now: Date.now(), observation: params.observation },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (marked.transition.kind !== "failed") {
    return "skipped";
  }
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
  if (deliveryContext) {
    await sendUnresumableSessionNotice({
      deliveryContext,
      entry: params.entry,
      gatewayRuntime: params.gatewayRuntime,
      reason: params.reason,
      sessionKey: params.sessionKey,
      text: UNRESUMABLE_SESSION_NOTICE,
    });
  }
  return "failed";
}
