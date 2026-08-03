import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

type CronAgentScope = {
  agentId?: string;
  sessionKey?: string;
};

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
    throw new Error("Cron job has no agent id and no configured default was provided.");
  }
  return normalizeAgentId(agentId);
}
