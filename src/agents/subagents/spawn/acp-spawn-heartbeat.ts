import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_HEARTBEAT_EVERY } from "../../../auto-reply/heartbeat.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { areHeartbeatsEnabled } from "../../../infra/heartbeat-wake.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../../routing/session-key.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.shared.js";
import { listAgentEntries } from "../../agent-scope-config.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../../agent-scope.js";

export function isHeartbeatEnabledForSessionAgent(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  if (!areHeartbeatsEnabled()) {
    return false;
  }
  const requesterAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!requesterAgentId) {
    return true;
  }

  const agentEntries = listAgentEntries(params.cfg);
  const hasExplicitHeartbeatAgents = agentEntries.some((entry) => Boolean(entry?.heartbeat));
  const enabledByPolicy = hasExplicitHeartbeatAgents
    ? agentEntries.some(
        (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === requesterAgentId,
      )
    : requesterAgentId === resolveDefaultAgentId(params.cfg);
  if (!enabledByPolicy) {
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

  const storePath = resolveStorePath(params.cfg.session?.store, {
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
