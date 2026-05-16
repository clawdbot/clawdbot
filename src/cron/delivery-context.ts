import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { CronDelivery, CronMessageChannel } from "./types.js";

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
    return { ...deliveryContext, threadId };
  }
  return deliveryContext;
}

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
