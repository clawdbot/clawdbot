import {
  createAccountCronScheduledToolPolicy,
  createTrustedCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../../cron/scheduled-tool-policy.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { GatewayClient } from "./types.js";

export type CronCallerScope = {
  kind: "agentTool";
  agentId: string;
  sessionKey?: string;
  accountId: string;
  currentJobId?: string;
};

export function readCronCallerScope(
  client: GatewayClient | null | undefined,
): CronCallerScope | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (!identity?.agentId) {
    return undefined;
  }
  const cronSelfManagementContext = identity.cronSelfManagementContext;
  const currentJobId =
    cronSelfManagementContext && Date.now() < cronSelfManagementContext.expiresAtMs
      ? cronSelfManagementContext.jobId.trim() || undefined
      : undefined;
  return {
    kind: "agentTool",
    agentId: normalizeAgentId(identity.agentId),
    sessionKey: identity.sessionKey?.trim() || undefined,
    accountId: normalizeAccountId(identity.turnSourceAccountId),
    currentJobId,
  };
}

/** Converts the authenticated gateway caller into server-only scheduled authority provenance. */
export function resolveCronScheduledToolPolicyForCaller(
  callerScope: CronCallerScope | undefined,
): CronScheduledToolPolicy {
  if (!callerScope) {
    return createTrustedCronScheduledToolPolicy();
  }
  const policy = callerScope.sessionKey
    ? createAccountCronScheduledToolPolicy({
        ownerSessionKey: callerScope.sessionKey,
        ownerAccountId: callerScope.accountId,
      })
    : undefined;
  if (!policy) {
    // An agent-runtime caller cannot be promoted to operator authority merely
    // because its signed runtime envelope omitted a session identity.
    throw new TypeError("agent-runtime cron mutations require an authenticated session identity");
  }
  return policy;
}

function resolveCronJobEffectiveAgentId(
  job: { agentId?: string },
  defaultAgentId?: string,
): string {
  const agentId = job.agentId ?? defaultAgentId;
  if (!agentId) {
    throw new Error("Cron job has no agent id and no configured default was provided.");
  }
  return normalizeAgentId(agentId);
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

function cronJobScheduledAuthorityMatchesCaller(
  job: CronJob,
  callerScope: CronCallerScope,
): boolean {
  const policy = job.scheduledToolPolicy;
  if (!policy) {
    return true;
  }
  // Trusted jobs remain operator-only. Account jobs reuse the exact persisted
  // session's group authority, so sibling sessions must not control them.
  if (policy.mode === "trusted") {
    return false;
  }
  const callerSessionKey = callerScope.sessionKey?.trim();
  return (
    callerSessionKey === policy.ownerSessionKey &&
    job.owner?.sessionKey?.trim() === policy.ownerSessionKey &&
    callerScope.accountId === normalizeAccountId(policy.ownerAccountId)
  );
}

function cronJobMatchesCurrentJobCapability(params: {
  job: CronJob;
  callerScope: CronCallerScope;
  defaultAgentId?: string;
}): boolean {
  if (
    params.callerScope.currentJobId !== params.job.id ||
    resolveCronJobEffectiveAgentId(params.job, params.defaultAgentId) !== params.callerScope.agentId
  ) {
    return false;
  }
  const policy = params.job.scheduledToolPolicy;
  return (
    policy?.mode !== "account" ||
    normalizeAccountId(policy.ownerAccountId) === params.callerScope.accountId
  );
}

export function cronJobMatchesCallerScope(params: {
  job: CronJob;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
  allowCurrentJob?: boolean;
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
  // A signed scheduled-run claim restores only the cron tool's historical
  // current-job surface. Callers must opt in per read/self-remove operation.
  if (
    params.allowCurrentJob === true &&
    cronJobMatchesCurrentJobCapability({
      job: params.job,
      callerScope: params.callerScope,
      defaultAgentId: params.defaultAgentId,
    })
  ) {
    return true;
  }
  if (!cronJobScheduledAuthorityMatchesCaller(params.job, params.callerScope)) {
    return false;
  }
  const ownerAccountId = params.job.owner?.accountId;
  // Operator-created records may name an account without an owner agent; account ownership is
  // therefore an independent boundary, not a refinement of ownerAgentId.
  if (ownerAccountId && normalizeAccountId(ownerAccountId) !== params.callerScope.accountId) {
    return false;
  }
  // Declarative jobs retain their stamped owner when an operator retargets execution.
  // Ownerless jobs predate attribution, so keep their routing-based visibility.
  const ownerAgentId = resolveCronJobOwnerAgentId(params.job);
  if (ownerAgentId) {
    if (ownerAgentId !== params.callerScope.agentId) {
      return false;
    }
    return true;
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

  // Declarative convergence preserves the matched job's owner, so account identity must be part
  // of selection or a same-key declaration can mutate another account's authority envelope.
  if (
    normalizeAccountId(params.job.owner?.accountId) !==
    normalizeAccountId(params.input.owner?.accountId)
  ) {
    return false;
  }
  const inputOwnerSessionKey = params.input.owner?.sessionKey;
  const inputOwnerAgentId =
    params.input.owner?.agentId ?? parseAgentIdFromSessionRef(inputOwnerSessionKey);
  if (inputOwnerSessionKey && !inputOwnerAgentId) {
    return params.job.owner?.sessionKey === inputOwnerSessionKey;
  }
  const inputAgentIdRaw = inputOwnerAgentId ?? params.input.agentId ?? params.defaultAgentId;
  const jobAgentIdRaw =
    resolveCronJobOwnerAgentId(params.job) ?? params.job.agentId ?? params.defaultAgentId;
  if (!inputAgentIdRaw || !jobAgentIdRaw) {
    throw new Error("Cron declaration has no agent id and no configured default was provided.");
  }
  const inputAgentId = normalizeAgentId(inputAgentIdRaw);
  const jobAgentId = normalizeAgentId(jobAgentIdRaw);
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
  const effectiveAgentId = resolveCronJobEffectiveAgentId(params.job, params.defaultAgentId);
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
      accountId: callerScope.accountId,
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
