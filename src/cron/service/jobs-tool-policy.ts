import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronJob } from "../types.js";

export function stampScheduledToolPolicy(
  job: CronJob,
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

export function reconcileScheduledToolPolicy(params: {
  job: CronJob;
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

export function reconcileToolsAllowProvenance(params: {
  job: CronJob;
  explicitlyMutatesToolsAllow: boolean;
  toolsAllowProvenance?: CronJob["toolsAllowProvenance"];
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
