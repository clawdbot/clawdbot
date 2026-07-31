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
      reason === "wake",
  };
}

export function isTargetedImmediateSystemEventWake(params: {
  source?: HeartbeatWakeSource;
  intent?: HeartbeatWakeIntent;
  reason?: string;
  sessionKey?: string;
}): boolean {
  return (
    params.source === "notifications-event" &&
    params.intent === "immediate" &&
    params.reason?.trim() === "wake" &&
    normalizeOptionalString(params.sessionKey) !== undefined
  );
}

export function isConfiguredHeartbeatAgent(cfg: OpenClawConfig, agentId: string): boolean {
  const normalized = normalizeAgentId(agentId);
  return listAgentIds(cfg).some((candidate) => normalizeAgentId(candidate) === normalized);
}
