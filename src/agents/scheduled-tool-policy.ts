import {
  normalizeCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../cron/scheduled-tool-policy.js";
import { parseSessionDeliveryRoute } from "../routing/session-key.js";

/** Trusted runtime context for a scheduled run with a server-stamped tool cap. */
export type ScheduledToolPolicyContext =
  | Extract<CronScheduledToolPolicy, { mode: "trusted" }>
  | (Extract<CronScheduledToolPolicy, { mode: "account" }> & { ownerChannel: string });

/** Builds scheduled policy context only when both the cap and trusted owner exist. */
export function resolveScheduledToolPolicyContext(params: {
  toolsAllow?: readonly string[];
  scheduledToolPolicy?: unknown;
}): ScheduledToolPolicyContext | undefined {
  if (params.toolsAllow === undefined) {
    return undefined;
  }
  const policy = normalizeCronScheduledToolPolicy(params.scheduledToolPolicy);
  if (!policy || policy.mode === "trusted") {
    return policy;
  }
  const ownerChannel = parseSessionDeliveryRoute(policy.ownerSessionKey)?.channel;
  return ownerChannel ? { ...policy, ownerChannel } : undefined;
}
