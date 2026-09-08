import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

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

export async function announceRestartRecoveryResumption(
  params: MainSessionRecoveryStoreTarget & {
    sessionId: string;
    recoveryRunId: string;
    lifecycleGeneration: string;
    deliveryContext: DeliveryContext & { channel: string; to: string };
    cfg?: OpenClawConfig;
    shouldContinue?: () => boolean;
    gatewayRuntime: GatewayRecoveryRuntime;
  },
): Promise<void> {
  const isCurrent = () => {
    if (
      params.shouldContinue?.() === false ||
      getAgentEventLifecycleGeneration() !== params.lifecycleGeneration
    ) {
      return false;
    }
    const current = loadSessionEntryReadOnly(params);
    return (
      current?.sessionId === params.sessionId &&
      current.status === "running" &&
      current.abortedLastRun !== true &&
      current.restartRecoveryDeliveryRunId === params.recoveryRunId &&
      deliveryContextKey(
        resolveRestartRecoveryDeliveryContext({
          cfg: params.cfg,
          entry: current,
          sessionKey: params.sessionKey,
        }),
      ) === deliveryContextKey(params.deliveryContext)
    );
  };
  try {
    if (!isCurrent()) {
      return;
    }
    await params.gatewayRuntime.sendRecoveryNotice({
      ...params.deliveryContext,
      text: "I'm continuing your interrupted request after the gateway restart. I'll post the result here.",
      idempotencyKey: `main-session-restart-recovery:${params.recoveryRunId}:resumed-notice`,
      isCurrent,
    });
  } catch (error) {
    // A notice failure must not replay an already admitted recovery turn.
    mainSessionRecoveryLog.warn(
      `failed to announce restart recovery ${params.sessionKey}: ${String(error)}`,
    );
  }
}
