import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  type CronScheduledToolCallerOrigin,
  type CronScheduledToolPolicy,
} from "../cron/scheduled-tool-policy.js";

/** Trusted runtime context for a scheduled run with a server-stamped tool cap. */
export type ScheduledToolPolicyContext =
  | Extract<CronScheduledToolPolicy, { mode: "trusted" }>
  | (Extract<CronScheduledToolPolicy, { mode: "account" }> & {
      /** Missing legacy runtime contexts are treated as unknown and fail closed. */
      ownerOrigin?: CronScheduledToolCallerOrigin;
    });

/** Separates a scheduled creator's authorization identity from its delivery route. */
export function resolveScheduledToolCallerContext(params: {
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  accountId?: string;
  channel?: string;
}): { accountId?: string; channel?: string | null; local?: true; scheduled?: true } {
  const policy = params.scheduledToolPolicy;
  const origin = policy?.mode === "account" ? policy.ownerOrigin : undefined;
  return {
    accountId: policy?.ownerAccountId ?? params.accountId,
    ...(policy ? { scheduled: true as const } : {}),
    ...(origin?.kind === "local" ? { local: true as const } : {}),
    channel:
      origin?.kind === "external"
        ? origin.channel
        : origin?.kind === "local"
          ? undefined
          : policy?.mode === "account"
            ? null
            : params.channel,
  };
}

/** Builds scheduled policy context only when both the cap and trusted owner exist. */
export function resolveScheduledToolPolicyContext(params: {
  toolsAllow?: readonly string[];
  scheduledToolPolicy?: unknown;
  callerOrigin?: unknown;
}): ScheduledToolPolicyContext | undefined {
  if (params.toolsAllow === undefined) {
    return undefined;
  }
  const rawPolicy = params.scheduledToolPolicy;
  const policy = normalizeCronScheduledToolPolicy(
    isRecord(rawPolicy) && rawPolicy.mode === "account"
      ? {
          version: rawPolicy.version,
          mode: rawPolicy.mode,
          ownerSessionKey: rawPolicy.ownerSessionKey,
          ownerAccountId: rawPolicy.ownerAccountId,
        }
      : rawPolicy,
  );
  if (!policy || policy.mode === "trusted") {
    return policy;
  }
  return {
    ...policy,
    ownerOrigin: normalizeCronScheduledToolCallerOrigin(
      params.callerOrigin ?? (isRecord(rawPolicy) ? rawPolicy.ownerOrigin : undefined),
    ),
  };
}
