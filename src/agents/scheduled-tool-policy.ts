import {
  normalizeCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../cron/scheduled-tool-policy.js";

/** Trusted runtime context for a scheduled run with a server-stamped tool cap. */
export type ScheduledToolPolicyContext = CronScheduledToolPolicy;

/** Builds scheduled policy context only when both the cap and trusted owner exist. */
export function resolveScheduledToolPolicyContext(params: {
  toolsAllow?: readonly string[];
  scheduledToolPolicy?: unknown;
}): ScheduledToolPolicyContext | undefined {
  if (params.toolsAllow === undefined) {
    return undefined;
  }
  return normalizeCronScheduledToolPolicy(params.scheduledToolPolicy);
}
