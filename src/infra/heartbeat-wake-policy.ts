import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { HeartbeatWakeIntent, HeartbeatWakeSource } from "./heartbeat-wake.js";

export type HeartbeatWakePayloadFlags = {
  isExecEventWake: boolean;
  isCronWake: boolean;
  isWakePayload: boolean;
};

export function inferHeartbeatWakeSourceFromReason(
  reason?: string,
): HeartbeatWakeSource | undefined {
  const trimmed = (reason ?? "").trim();
  if (trimmed === "exec-event") {
    return "exec-event";
  }
  if (trimmed.startsWith("cron:")) {
    return "cron";
  }
  if (trimmed === "wake" || trimmed.startsWith("hook:")) {
    return "hook";
  }
  if (trimmed.startsWith("acp:spawn:")) {
    return "acp-spawn";
  }
  if (trimmed.startsWith("session-state:")) {
    return "session-state";
  }
  return undefined;
}

export function resolveHeartbeatWakePayloadFlags(params: {
  source?: HeartbeatWakeSource;
  reason?: string;
}): HeartbeatWakePayloadFlags {
  const source = params.source ?? inferHeartbeatWakeSourceFromReason(params.reason);
  const reason = (params.reason ?? "").trim();
  return {
    isExecEventWake: source === "exec-event",
    isCronWake: source === "cron",
    isWakePayload:
      source === "hook" ||
      source === "acp-spawn" ||
      source === "session-state" ||
      source === "background-task" ||
      source === "background-task-blocked" ||
      reason === "wake",
  };
}

type TargetedImmediateWakeParams = {
  source?: HeartbeatWakeSource;
  intent?: HeartbeatWakeIntent;
  reason?: string;
  agentId?: string;
  sessionKey?: string;
};

export function isTargetedImmediateUnscheduledWake(params: TargetedImmediateWakeParams): boolean {
  if (params.intent !== "immediate") {
    return false;
  }
  const hasSessionTarget = normalizeOptionalString(params.sessionKey) !== undefined;
  const hasTarget = hasSessionTarget || normalizeOptionalString(params.agentId) !== undefined;
  if (!hasTarget) {
    return false;
  }

  // These sources queue targeted events that would otherwise sit unread for a
  // configured agent without a recurring heartbeat schedule.
  switch (params.source) {
    case "notifications-event":
      return hasSessionTarget && params.reason?.trim() === "wake";
    case "hook":
      return params.reason?.trim().startsWith("hook:") ?? false;
    case "background-task":
    case "background-task-blocked":
      return true;
    default:
      return false;
  }
}

export function isConfiguredHeartbeatAgent(cfg: OpenClawConfig, agentId: string): boolean {
  const normalized = normalizeAgentId(agentId);
  return listAgentIds(cfg).some((candidate) => normalizeAgentId(candidate) === normalized);
}
