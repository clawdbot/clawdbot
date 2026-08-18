import {
  tryResolveLegacyCompatibilityAgentId,
  tryResolveSystemAgentTargetAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

type CronAgentScope = {
  agentId?: string | null;
  sessionKey?: string | null;
};

export const CRON_AGENT_SELECTION_REQUIRED_MESSAGE =
  "Agent-less cron job has no resolvable owner. Pass --agent <id> when creating or editing the job, or set agents.defaults.systemAgent.agentId.";

/** Keeps shipped legacy defaults while routing modern ambient jobs through the system owner. */
export function tryResolveCronDefaultAgentId(cfg: OpenClawConfig): string | undefined {
  return tryResolveLegacyCompatibilityAgentId(cfg) ?? tryResolveSystemAgentTargetAgentId(cfg);
}

/** Resolves cron ownership: explicit non-blank id, scoped session key, then configured default. */
export function resolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
): string {
  const agentId =
    job.agentId?.trim() ||
    parseAgentSessionKey(job.sessionKey)?.agentId ||
    configuredDefaultAgentId?.trim();
  if (!agentId) {
    throw new Error(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
  }
  return normalizeAgentId(agentId);
}
