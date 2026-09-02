import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

type CronAgentScope = {
  agentId?: string | null;
  sessionKey?: string | null;
};

export const CRON_AGENT_SELECTION_REQUIRED_MESSAGE =
  "Agent-less cron job has no resolvable owner. Pass --agent <id> when creating or editing the job, or set agents.defaults.systemAgent.agentId.";

/** Resolves cron ownership without throwing: explicit non-blank id, scoped session key, then configured default. */
export function tryResolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
): string | undefined {
  const raw =
    job.agentId?.trim() ||
    parseAgentSessionKey(job.sessionKey)?.agentId ||
    configuredDefaultAgentId?.trim();
  return raw ? normalizeAgentId(raw) : undefined;
}

/** Resolves cron ownership: explicit non-blank id, scoped session key, then configured default. */
export function resolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
): string {
  const agentId = tryResolveCronJobEffectiveAgentId(job, configuredDefaultAgentId);
  if (!agentId) {
    throw new Error(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
  }
  return agentId;
}
