/** Converts live or stored session routing into cron delivery config. */
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { CronDelivery, CronMessageChannel } from "./types.js";

/** Converts an active delivery context into cron announce delivery config. */
export function cronDeliveryFromContext(context?: DeliveryContext): CronDelivery | null {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.to) {
    return null;
  }
  const delivery: CronDelivery = {
    mode: "announce",
    to: normalized.to,
  };
  if (normalized.channel) {
    delivery.channel = normalized.channel as CronMessageChannel;
  }
  if (normalized.accountId) {
    delivery.accountId = normalized.accountId;
  }
  if (normalized.threadId != null) {
    delivery.threadId = normalized.threadId;
  }
  return delivery;
}

/** Recovers delivery context from a stored session key captured when the cron job was created. */
export function resolveCronStoredDeliveryContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
}): DeliveryContext | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey, { cfg: params.cfg });
  if (deliveryContext && threadId) {
    // Parsed session-key thread ids are canonical; replace any stale thread value in stored context.
    return { ...deliveryContext, threadId };
  }
  return deliveryContext;
}

/** Resolves initial cron delivery, preferring the live context before falling back to session storage. */
export function resolveCronCreationDelivery(params: {
  cfg: OpenClawConfig;
  currentDeliveryContext?: DeliveryContext;
  agentSessionKey?: string;
}): CronDelivery | null {
  return (
    cronDeliveryFromContext(params.currentDeliveryContext) ??
    cronDeliveryFromContext(
      resolveCronStoredDeliveryContext({
        cfg: params.cfg,
        sessionKey: params.agentSessionKey,
      }),
    )
  );
}
