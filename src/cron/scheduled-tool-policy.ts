import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAccountId } from "../routing/account-id.js";

/** Closed, server-authored origin of an account-scoped scheduled tool cap. */
export type CronScheduledToolCallerOrigin =
  | { kind: "external"; channel: string }
  | { kind: "local" }
  | { kind: "unknown" };

/** Invalid, legacy, or incomplete origin facts stay explicitly unknown. */
export function normalizeCronScheduledToolCallerOrigin(
  value: unknown,
): CronScheduledToolCallerOrigin {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return { kind: "unknown" };
  }
  const keys = Object.keys(value);
  if (value.kind === "local" && keys.every((key) => key === "kind")) {
    return { kind: "local" };
  }
  if (value.kind === "unknown" && keys.every((key) => key === "kind")) {
    return { kind: "unknown" };
  }
  const channel = normalizeOptionalString(
    value.kind === "external" && typeof value.channel === "string" ? value.channel : undefined,
  )?.toLowerCase();
  return channel && keys.every((key) => key === "kind" || key === "channel")
    ? { kind: "external", channel }
    : { kind: "unknown" };
}

/**
 * Restrict-only execution target for a job's exec grant, captured from a
 * creator surface whose only exec capability was host-pinned. New pinned jobs
 * persist this as part of a grant-coupled envelope; unmarked legacy jobs keep
 * baseline exec behavior.
 */
export type CronToolsAllowExecTarget = {
  version: 1;
  host: "gateway";
  /** Mandatory approval floor inherited from the captured creator surface. */
  ask?: "always";
};

/** Persisted proof that this job was created with an exact exec restriction. */
export type CronToolsAllowExecTargetRequirement =
  | {
      version: 1;
      target: CronToolsAllowExecTarget;
      grantIndex: number;
      recoveryRequired?: never;
    }
  | {
      version: 1;
      target?: never;
      recoveryRequired: true;
    };

/** Retains only recognized restrictions; future fields remain reader-safe. */
export function normalizeCronToolsAllowExecTarget(
  value: unknown,
): CronToolsAllowExecTarget | undefined {
  return isRecord(value) && value.version === 1 && value.host === "gateway"
    ? {
        version: 1,
        host: "gateway",
        ...(value.ask === "always" ? { ask: "always" } : {}),
      }
    : undefined;
}

/** Invalid requirement markers remain durable fail-closed recovery state. */
export function normalizeCronToolsAllowExecTargetRequirement(
  value: unknown,
): CronToolsAllowExecTargetRequirement | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1) {
    return { version: 1, recoveryRequired: true };
  }
  if (value.recoveryRequired === true) {
    return { version: 1, recoveryRequired: true };
  }
  const rawTarget = value.target;
  const target =
    isRecord(rawTarget) &&
    rawTarget.version === 1 &&
    rawTarget.host === "gateway" &&
    (rawTarget.ask === undefined || rawTarget.ask === "always")
      ? {
          version: 1 as const,
          host: "gateway" as const,
          ...(rawTarget.ask === "always" ? { ask: "always" as const } : {}),
        }
      : undefined;
  const grantIndex = value.grantIndex;
  return target && typeof grantIndex === "number" && Number.isInteger(grantIndex) && grantIndex >= 0
    ? { version: 1, target, grantIndex }
    : { version: 1, recoveryRequired: true };
}

function resolveMatchingCronExecTarget(params: {
  requirement?: unknown;
  execTarget?: unknown;
}): Extract<CronToolsAllowExecTargetRequirement, { target: CronToolsAllowExecTarget }> | undefined {
  const requirement = normalizeCronToolsAllowExecTargetRequirement(params.requirement);
  const execTarget = normalizeCronToolsAllowExecTarget(params.execTarget);
  return requirement &&
    "target" in requirement &&
    requirement.target !== undefined &&
    execTarget?.host === requirement.target.host &&
    execTarget.ask === requirement.target.ask
    ? requirement
    : undefined;
}

/** Removes a pinned exec grant from the generic persisted cap; the private envelope owns it. */
export function stripCronPinnedExecGrant(params: {
  toolsAllow?: readonly string[];
  requirement?: unknown;
}): string[] | undefined {
  if (!params.toolsAllow) {
    return undefined;
  }
  return normalizeCronToolsAllowExecTargetRequirement(params.requirement)
    ? params.toolsAllow.filter((tool) => tool !== "exec")
    : [...params.toolsAllow];
}

/** Rehydrates canonical exec only after the persisted grant and restriction agree. */
export function restoreCronPinnedExecGrant(params: {
  toolsAllow?: readonly string[];
  requirement?: unknown;
  execTarget?: unknown;
}): string[] | undefined {
  if (!params.toolsAllow) {
    return undefined;
  }
  const requirement = resolveMatchingCronExecTarget(params);
  if (!requirement || params.toolsAllow.includes("exec")) {
    return [...params.toolsAllow];
  }
  const restored = [...params.toolsAllow];
  restored.splice(Math.min(requirement.grantIndex, restored.length), 0, "exec");
  return restored;
}

/** Returns operator-visible recovery guidance when a required pin cannot be proven intact. */
export function resolveCronToolsAllowExecTargetRecoveryError(params: {
  jobId?: string;
  requirement?: unknown;
  execTarget?: unknown;
}): string | undefined {
  const requirement = normalizeCronToolsAllowExecTargetRequirement(params.requirement);
  if (!requirement) {
    return undefined;
  }
  if (resolveMatchingCronExecTarget(params)) {
    return undefined;
  }
  const subject = params.jobId ? `Automation ${params.jobId}` : "This automation";
  const recoveryCommand = params.jobId
    ? `openclaw automations edit ${params.jobId} --tools <tool,...>`
    : "openclaw automations list --all";
  return (
    `${subject} cannot run because its captured exec restriction is missing or invalid. ` +
    "No trigger, script, or agent action was executed. Recreate it from a fresh authenticated creator turn, " +
    `or explicitly reauthorize its complete tool cap from a trusted operator shell with ` +
    `\`${recoveryCommand}\`.`
  );
}

/** Server-authored provenance for a persisted scheduled tool-cap authority envelope. */
export type CronScheduledToolPolicy =
  | {
      version: 1;
      mode: "trusted";
      ownerSessionKey?: never;
      ownerAccountId?: never;
    }
  | {
      version: 1;
      mode: "account";
      ownerSessionKey: string;
      ownerAccountId: string;
    };

/** Creates provenance for an authenticated operator or trusted in-process caller. */
export function createTrustedCronScheduledToolPolicy(): CronScheduledToolPolicy {
  return { version: 1, mode: "trusted" };
}

/** Creates requester-scoped provenance from an authenticated account identity. */
export function createAccountCronScheduledToolPolicy(params: {
  ownerSessionKey: string;
  ownerAccountId: string;
}): CronScheduledToolPolicy | undefined {
  const ownerSessionKey = normalizeOptionalString(params.ownerSessionKey);
  const ownerAccountId = normalizeOptionalAccountId(params.ownerAccountId);
  if (!ownerSessionKey || !ownerAccountId) {
    return undefined;
  }
  return { version: 1, mode: "account", ownerSessionKey, ownerAccountId };
}

/** Accepts only the current closed provenance shape; unknown versions fail closed. */
export function normalizeCronScheduledToolPolicy(
  value: unknown,
): CronScheduledToolPolicy | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  if (value.mode === "trusted") {
    return Object.keys(value).every((key) => key === "version" || key === "mode")
      ? createTrustedCronScheduledToolPolicy()
      : undefined;
  }
  if (value.mode !== "account") {
    return undefined;
  }
  const policy = createAccountCronScheduledToolPolicy({
    ownerSessionKey: typeof value.ownerSessionKey === "string" ? value.ownerSessionKey : "",
    ownerAccountId: typeof value.ownerAccountId === "string" ? value.ownerAccountId : "",
  });
  if (!policy) {
    return undefined;
  }
  return Object.keys(value).every(
    (key) =>
      key === "version" || key === "mode" || key === "ownerSessionKey" || key === "ownerAccountId",
  )
    ? policy
    : undefined;
}

/** Resolves trusted provenance only when it is consistent with the persisted job owner. */
export function resolveCronScheduledToolPolicy(params: {
  toolsAllow?: readonly string[];
  scheduledToolPolicy?: unknown;
  owner?: { sessionKey?: string; accountId?: string };
}): CronScheduledToolPolicy | undefined {
  if (params.toolsAllow === undefined) {
    return undefined;
  }
  const policy = normalizeCronScheduledToolPolicy(params.scheduledToolPolicy);
  if (!policy || policy.mode === "trusted") {
    return policy;
  }
  const ownerSessionKey = normalizeOptionalString(params.owner?.sessionKey);
  const ownerAccountId = normalizeOptionalAccountId(params.owner?.accountId);
  return ownerSessionKey === policy.ownerSessionKey && ownerAccountId === policy.ownerAccountId
    ? policy
    : undefined;
}
