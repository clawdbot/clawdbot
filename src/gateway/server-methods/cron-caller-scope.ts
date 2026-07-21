import type { CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { GatewayClient } from "./types.js";

export type CronCallerScope = {
  kind: "agentTool";
  agentId: string;
  sessionKey?: string;
};

export function readCronCallerScope(
  client: GatewayClient | null | undefined,
): CronCallerScope | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (!identity?.agentId) {
    return undefined;
  }
  return {
    kind: "agentTool",
    agentId: normalizeAgentId(identity.agentId),
    sessionKey: identity.sessionKey?.trim() || undefined,
  };
}

function resolveCronJobEffectiveAgentId(job: CronJob, defaultAgentId?: string): string {
  return normalizeAgentId(job.agentId ?? defaultAgentId ?? DEFAULT_AGENT_ID);
}

function parseAgentIdFromSessionRef(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? parseAgentSessionKey(trimmed)?.agentId : undefined;
}

function parseAgentIdFromCronSessionTarget(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.startsWith("session:")
    ? parseAgentIdFromSessionRef(trimmed.slice("session:".length))
    : undefined;
}

function cronJobSessionRefsMatchCaller(job: CronJob, callerScope: CronCallerScope): boolean {
  const sessionAgentId = parseAgentIdFromSessionRef(job.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId = parseAgentIdFromCronSessionTarget(job.sessionTarget);
  return !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === callerScope.agentId;
}

function resolveCronJobOwnerAgentId(job: CronJob): string | undefined {
  const ownerAgentId = job.owner?.agentId ?? parseAgentIdFromSessionRef(job.owner?.sessionKey);
  return ownerAgentId ? normalizeAgentId(ownerAgentId) : undefined;
}

function isOperatorCommandCronJob(job: CronJob): boolean {
  return (
    job.payload.kind === "command" ||
    job.schedule.kind === "on-exit" ||
    job.schedule.kind === "stream"
  );
}

export function cronJobMatchesCallerScope(params: {
  job: CronJob;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  // Command cron is an operator-admin automation surface, not a model-visible
  // agent tool capability. Hide it before owner/routing fallback can expose
  // payload env, watched commands, or manual force-run controls.
  if (isOperatorCommandCronJob(params.job)) {
    return false;
  }
  // Declarative jobs retain their stamped owner when an operator retargets execution.
  // Ownerless jobs predate attribution, so keep their routing-based visibility.
  const ownerAgentId = resolveCronJobOwnerAgentId(params.job);
  if (ownerAgentId) {
    return ownerAgentId === params.callerScope.agentId;
  }
  if (
    resolveCronJobEffectiveAgentId(params.job, params.defaultAgentId) !== params.callerScope.agentId
  ) {
    return false;
  }
  return cronJobSessionRefsMatchCaller(params.job, params.callerScope);
}

export function cronJobMatchesDeclarationScope(params: {
  job: CronJob;
  input: CronJobCreate;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (params.callerScope) {
    return cronJobMatchesCallerScope(params);
  }

  const inputOwnerSessionKey = params.input.owner?.sessionKey;
  const inputOwnerAgentId =
    params.input.owner?.agentId ?? parseAgentIdFromSessionRef(inputOwnerSessionKey);
  if (inputOwnerSessionKey && !inputOwnerAgentId) {
    return params.job.owner?.sessionKey === inputOwnerSessionKey;
  }
  const inputAgentId = normalizeAgentId(
    inputOwnerAgentId ?? params.input.agentId ?? params.defaultAgentId ?? DEFAULT_AGENT_ID,
  );
  const jobAgentId = normalizeAgentId(
    resolveCronJobOwnerAgentId(params.job) ??
      params.job.agentId ??
      params.defaultAgentId ??
      DEFAULT_AGENT_ID,
  );
  return jobAgentId === inputAgentId;
}

export function cronCreateMatchesCallerScope(params: {
  job: CronJobCreate;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  const effectiveAgentId = normalizeAgentId(
    params.job.agentId ?? params.defaultAgentId ?? DEFAULT_AGENT_ID,
  );
  if (effectiveAgentId !== params.callerScope.agentId) {
    return false;
  }
  const sessionAgentId = parseAgentIdFromSessionRef(params.job.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== params.callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId = parseAgentIdFromCronSessionTarget(params.job.sessionTarget);
  return (
    !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === params.callerScope.agentId
  );
}

export function applyCronCreateCallerScopeDefault(
  job: CronJobCreate,
  callerScope: CronCallerScope | undefined,
): CronJobCreate {
  if (!callerScope) {
    return job;
  }
  return {
    ...job,
    agentId: job.agentId ?? callerScope.agentId,
    owner: {
      agentId: callerScope.agentId,
      ...(callerScope.sessionKey ? { sessionKey: callerScope.sessionKey } : {}),
    },
  };
}

export function cronPatchSessionRefsMatchCaller(
  patch: CronJobPatch,
  callerScope: CronCallerScope | undefined,
): boolean {
  if (!callerScope) {
    return true;
  }
  const sessionAgentId =
    "sessionKey" in patch && typeof patch.sessionKey === "string"
      ? parseAgentIdFromSessionRef(patch.sessionKey)
      : undefined;
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId =
    "sessionTarget" in patch && typeof patch.sessionTarget === "string"
      ? parseAgentIdFromCronSessionTarget(patch.sessionTarget)
      : undefined;
  return !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === callerScope.agentId;
}
