import { cloneCronRuntimeAuthority } from "../runtime-authority.js";
import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type {
  CronStoredJob,
  CronToolsAllowExecTarget,
  CronToolsAllowExecTargetRequirement,
  CronToolsAllowProvenance,
} from "../types.js";
import type { CronAddOptions } from "./state.js";

function stampScheduledToolPolicy(
  job: CronStoredJob,
  scheduledToolPolicy: CronScheduledToolPolicy | undefined,
): void {
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    return;
  }
  const policy = scheduledToolPolicy ?? createTrustedCronScheduledToolPolicy();
  if (
    policy.mode === "account" &&
    (job.owner?.sessionKey !== policy.ownerSessionKey ||
      job.owner?.accountId !== policy.ownerAccountId)
  ) {
    throw new Error("scheduled account policy must match the persisted job owner");
  }
  job.scheduledToolPolicy = structuredClone(policy);
}

function reconcileScheduledToolPolicy(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  explicitlyMutatesToolsAllow: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    return;
  }
  const current = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (current) {
    job.scheduledToolPolicy = current;
    return;
  }
  delete job.scheduledToolPolicy;
  if (params.explicitlyMutatesToolsAllow || !params.previouslyUsedToolRuntime) {
    stampScheduledToolPolicy(job, params.scheduledToolPolicy);
  }
}

/**
 * Stamps or clears the restrict-only exec pin alongside the cap it was
 * captured with. The pin exists only while the job grants canonical `exec`
 * from a creator surface whose exec capability was host-pinned; explicit cap
 * rewrites without that server-verified fact clear it, falling back to the
 * baseline unpinned exec policy.
 */
function reconcileToolsAllowExecTarget(params: {
  job: CronStoredJob;
  explicitlyMutatesToolsAllow: boolean;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.toolsAllowExecTarget;
    delete job.toolsAllowExecTargetRequirement;
    return;
  }
  if (!params.explicitlyMutatesToolsAllow) {
    return;
  }
  const grantsExec =
    Array.isArray(job.payload.toolsAllow) && job.payload.toolsAllow.includes("exec");
  if (params.toolsAllowExecTarget && grantsExec) {
    job.toolsAllowExecTarget = structuredClone(params.toolsAllowExecTarget);
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: structuredClone(params.toolsAllowExecTarget),
      grantIndex: job.payload.toolsAllow.indexOf("exec"),
    } satisfies CronToolsAllowExecTargetRequirement;
  } else {
    delete job.toolsAllowExecTarget;
    delete job.toolsAllowExecTargetRequirement;
  }
}

function reconcileToolsAllowProvenance(params: {
  job: CronStoredJob;
  explicitlyMutatesToolsAllow: boolean;
  toolsAllowProvenance?: CronToolsAllowProvenance;
}): void {
  if (!params.explicitlyMutatesToolsAllow) {
    return;
  }
  if (
    params.job.payload.toolsAllowIsDefault === true &&
    params.toolsAllowProvenance?.version === 1 &&
    params.toolsAllowProvenance.source === "final-executable-surface"
  ) {
    params.job.toolsAllowProvenance = structuredClone(params.toolsAllowProvenance);
    return;
  }
  delete params.job.toolsAllowProvenance;
}

/** Reconciles runtime-owned opaque authority with the mutation that owns this write. */
export function reconcileRuntimeAuthority(params: {
  job: CronStoredJob;
  opts?: Pick<CronAddOptions, "commitGuard" | "captureRuntimeAuthority">;
  validateOwner?: () => void;
  explicitlyMutatesToolsAllow: boolean;
}): void {
  const { job, opts } = params;
  // Validation-only guards must not look like an empty fresh capture: that
  // would erase an existing runtime ceiling during an otherwise routine edit.
  opts?.commitGuard?.();
  params.validateOwner?.();
  const hasCapture = opts?.captureRuntimeAuthority !== undefined;
  const captured = opts?.captureRuntimeAuthority?.();
  if (!cronJobUsesToolRuntime(job)) {
    // Runtime authority cannot survive a payload transition into a path that
    // does not execute the captured tool surface and later reappear on reuse.
    delete job.runtimeAuthority;
    delete job.runtimeAuthorityRecoveryRequired;
    return;
  }
  if (hasCapture) {
    delete job.runtimeAuthorityRecoveryRequired;
    const runtimeAuthority = captured ? cloneCronRuntimeAuthority(captured) : undefined;
    if (captured && !runtimeAuthority) {
      throw new TypeError("captured cron runtime authority is invalid");
    }
    if (runtimeAuthority) {
      job.runtimeAuthority = runtimeAuthority;
    } else {
      // A fresh exact-surface capture with no runtime authority intentionally
      // replaces any older runtime-specific grant instead of retaining it.
      delete job.runtimeAuthority;
    }
    return;
  }
  if (params.explicitlyMutatesToolsAllow && job.runtimeAuthority) {
    // Explicit tool caps are a complete replacement. Runtime-owned authority
    // may be restored only by another authenticated exact-surface capture.
    job.runtimeAuthorityRecoveryRequired = true;
    delete job.runtimeAuthority;
  }
}

/** Reconciles the scheduled policy, capture provenance, and exec pin as one cap-authority unit. */
export function reconcileToolsAllowAuthority(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  explicitlyMutatesToolsAllow: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
  toolsAllowProvenance?: CronToolsAllowProvenance;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
}): void {
  reconcileScheduledToolPolicy(params);
  reconcileToolsAllowProvenance(params);
  reconcileToolsAllowExecTarget(params);
}
