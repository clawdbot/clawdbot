import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { CronToolCallerScope, CronToolOptions } from "./cron-tool.types.js";

export function resolveCronToolCallerScope(
  opts: CronToolOptions | undefined,
  cfg: OpenClawConfig,
): CronToolCallerScope | undefined {
  const sessionKey = opts?.agentSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  return {
    kind: "agentTool",
    agentId: resolveSessionAgentId({ sessionKey, config: cfg }),
  };
}

export function readCronToolAgentId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? normalizeAgentId(value) : undefined;
}

function readAgentIdFromCronToolSessionRef(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? parseAgentSessionKey(value.trim())?.agentId
    : undefined;
}

function readAgentIdFromCronToolSessionTarget(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("session:")) {
    return undefined;
  }
  return readAgentIdFromCronToolSessionRef(trimmed.slice("session:".length));
}

export function assertCronToolAgentFieldMatchesScope(params: {
  value: unknown;
  field: string;
  callerScope: CronToolCallerScope;
}): void {
  if (params.value === undefined) {
    return;
  }
  const agentId = readCronToolAgentId(params.value);
  if (agentId && agentId === params.callerScope.agentId) {
    return;
  }
  throw new Error(`${params.field} must match the calling agent`);
}

export function assertCronToolSessionRefsMatchScope(
  value: Record<string, unknown>,
  callerScope: CronToolCallerScope,
): void {
  const sessionAgentId = readAgentIdFromCronToolSessionRef(value.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    throw new Error("automations sessionKey must match the calling agent");
  }
  const sessionTargetAgentId = readAgentIdFromCronToolSessionTarget(value.sessionTarget);
  if (sessionTargetAgentId && normalizeAgentId(sessionTargetAgentId) !== callerScope.agentId) {
    throw new Error("automations sessionTarget must match the calling agent");
  }
}
