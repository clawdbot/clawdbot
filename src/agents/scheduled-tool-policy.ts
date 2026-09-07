import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  type CronScheduledToolCallerOrigin,
  type CronScheduledToolPolicy,
} from "../cron/scheduled-tool-policy.js";

/** Trusted runtime context for a scheduled run with a server-stamped tool cap. */
export type ScheduledToolPolicyContext = (
  | Extract<CronScheduledToolPolicy, { mode: "trusted" }>
  | (Extract<CronScheduledToolPolicy, { mode: "account" }> & {
      /** Missing legacy runtime contexts are treated as unknown and fail closed. */
      ownerOrigin?: CronScheduledToolCallerOrigin;
    })
) & {
  /** Restrict-only policy for the rebuilt exec tool; absence keeps baseline exec. */
  execTarget?: { host: "gateway"; ask?: "always" };
};

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
  execTarget?: unknown;
}): ScheduledToolPolicyContext | undefined {
  if (params.toolsAllow === undefined) {
    return undefined;
  }
  const rawPolicy = params.scheduledToolPolicy;
  // Already-resolved contexts carry context-only fields (ownerOrigin,
  // execTarget) that the strict persisted-policy normalizer rejects; rebuild
  // the closed policy shape for both modes before normalizing.
  const policy = normalizeCronScheduledToolPolicy(
    isRecord(rawPolicy) && rawPolicy.mode === "account"
      ? {
          version: rawPolicy.version,
          mode: rawPolicy.mode,
          ownerSessionKey: rawPolicy.ownerSessionKey,
          ownerAccountId: rawPolicy.ownerAccountId,
        }
      : isRecord(rawPolicy) && rawPolicy.mode === "trusted"
        ? { version: rawPolicy.version, mode: rawPolicy.mode }
        : rawPolicy,
  );
  if (!policy) {
    return undefined;
  }
  // Accept the persisted `{version: 1, host}` shape and an already-resolved
  // context's bare `{host}` shape; anything else keeps the baseline (no pin).
  const rawExecTarget =
    params.execTarget ?? (isRecord(rawPolicy) ? rawPolicy.execTarget : undefined);
  const pinned =
    isRecord(rawExecTarget) &&
    rawExecTarget.host === "gateway" &&
    (rawExecTarget.version === undefined || rawExecTarget.version === 1)
      ? {
          execTarget: {
            host: "gateway" as const,
            ...(rawExecTarget.ask === "always" ? { ask: "always" as const } : {}),
          },
        }
      : {};
  if (policy.mode === "trusted") {
    return { ...policy, ...pinned };
  }
  return {
    ...policy,
    ownerOrigin: normalizeCronScheduledToolCallerOrigin(
      params.callerOrigin ?? (isRecord(rawPolicy) ? rawPolicy.ownerOrigin : undefined),
    ),
    ...pinned,
  };
}
