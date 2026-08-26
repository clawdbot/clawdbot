import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_HEARTBEAT_EVERY } from "../../../auto-reply/heartbeat.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isHeartbeatEnabledForAgent } from "../../../infra/heartbeat-summary.js";
import { areHeartbeatsEnabled } from "../../../infra/heartbeat-wake.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.shared.js";
import { resolveAgentConfig, resolveSessionAgentIds } from "../../agent-scope.js";

export function isHeartbeatEnabledForSessionAgent(params: {
  cfg: OpenClawConfig;
  requesterAgentId?: string;
  sessionKey?: string;
}): boolean {
  if (!areHeartbeatsEnabled()) {
    return false;
  }
  if (!params.sessionKey?.trim()) {
    return true;
  }
  const requesterAgentId = resolveSessionAgentIds({
    config: params.cfg,
    agentId: params.requesterAgentId,
    sessionKey: params.sessionKey,
  }).sessionAgentId;

  if (!isHeartbeatEnabledForAgent(params.cfg, requesterAgentId)) {
    return false;
  }

  const heartbeatEvery =
    resolveAgentConfig(params.cfg, requesterAgentId)?.heartbeat?.every ??
    params.cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  const trimmedEvery = normalizeOptionalString(heartbeatEvery) ?? "";
  if (!trimmedEvery) {
    return false;
  }
  try {
    return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
  } catch {
    return false;
  }
}

function resolveHeartbeatConfigForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["heartbeat"] {
  const defaults = params.cfg.agents?.defaults?.heartbeat;
  const overrides = resolveAgentConfig(params.cfg, params.agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return undefined;
  }
  return {
    ...defaults,
    ...overrides,
  };
}

export function hasSessionLocalHeartbeatRelayRoute(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  requesterAgentId: string;
}): boolean {
  const scope = params.cfg.session?.scope ?? "per-sender";
  if (scope === "global") {
    return false;
  }

  const heartbeat = resolveHeartbeatConfigForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  if ((heartbeat?.target ?? "none") !== "last") {
    return false;
  }

  // Explicit delivery overrides are not session-local and can route updates
  // to unrelated destinations (for example a pinned ops channel).
  if (normalizeOptionalString(heartbeat?.to)) {
    return false;
  }
  if (normalizeOptionalString(heartbeat?.accountId)) {
    return false;
  }

  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.requesterAgentId,
  });
  const parentEntry = loadSessionEntryReadOnly({
    storePath,
    sessionKey: params.parentSessionKey,
    clone: false,
  });
  const parentDeliveryContext = deliveryContextFromSession(parentEntry);
  return Boolean(parentDeliveryContext?.channel && parentDeliveryContext.to);
}
