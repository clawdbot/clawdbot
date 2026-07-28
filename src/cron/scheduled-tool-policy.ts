import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAccountId } from "../routing/account-id.js";

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
