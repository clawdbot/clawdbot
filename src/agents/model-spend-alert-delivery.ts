import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPrivateOwnerRouteTarget } from "../routing/private-owner-route.js";
import {
  markModelSpendAlertsDelivered,
  markModelSpendAlertsUnknown,
  preparePendingModelSpendAlertBestEffort,
  type ModelSpendAlertCompletion,
  type PreparedModelSpendAlert,
} from "./model-spend-alerts.js";

const log = createSubsystemLogger("agents/model-spend");

/** Claims pending alerts only when the concrete destination is a configured owner DM. */
export function preparePrivateOwnerModelSpendAlertBestEffort(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  channel?: string;
  to?: string;
  chatType?: string;
}): PreparedModelSpendAlert | undefined {
  const channel = normalizeOptionalString(params.channel);
  const to = normalizeOptionalString(params.to);
  if (
    !channel ||
    !to ||
    normalizeChatType(params.chatType) !== "direct" ||
    !isPrivateOwnerRouteTarget({ cfg: params.cfg, channel, to })
  ) {
    return undefined;
  }
  return preparePendingModelSpendAlertBestEffort({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}

/** Best-effort completion for legacy channel sends that already reached the provider. */
export function markModelSpendAlertsDeliveredBestEffort(
  completion: ModelSpendAlertCompletion,
): void {
  try {
    markModelSpendAlertsDelivered(completion);
  } catch (error) {
    log.warn(`model-spend alert completion failed: ${String(error)}`);
  }
}

/** Best-effort terminal settlement when legacy delivery crossed an ambiguous platform boundary. */
export function markModelSpendAlertsUnknownBestEffort(completion: ModelSpendAlertCompletion): void {
  try {
    markModelSpendAlertsUnknown(completion);
  } catch (error) {
    log.warn(`model-spend alert unknown settlement failed: ${String(error)}`);
  }
}
