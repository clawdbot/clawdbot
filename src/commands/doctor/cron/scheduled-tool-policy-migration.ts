import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAccountCronScheduledToolPolicy,
  normalizeCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
} from "../../../cron/scheduled-tool-policy.js";
import { normalizeOptionalAccountId } from "../../../routing/account-id.js";
import { normalizeAgentId, parseSessionDeliveryRoute } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";

type ScheduledToolPolicyMigrationResult = {
  mutated: boolean;
  status: "current" | "migrated" | "legacy" | "invalid" | "not-applicable";
};

/** Collects operator-visible recovery outcomes while normalizing a cron store. */
export function createScheduledToolPolicyMigrationCollector() {
  const legacyJobs: string[] = [];
  const invalidJobs: string[] = [];
  return {
    legacyJobs,
    invalidJobs,
    migrate(raw: Record<string, unknown>, onMigrated: () => void) {
      const result = migrateScheduledToolPolicy(raw);
      const jobName = normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id);
      if (result.status === "migrated") {
        onMigrated();
      }
      if (result.status === "legacy" && jobName) {
        legacyJobs.push(jobName);
      } else if (result.status === "invalid" && jobName) {
        invalidJobs.push(jobName);
      }
      return result.mutated;
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function usesToolRuntime(raw: Record<string, unknown>): boolean {
  const payload = readRecord(raw.payload);
  const trigger = readRecord(raw.trigger);
  return (
    payload?.kind === "agentTurn" ||
    payload?.kind === "script" ||
    (typeof trigger?.script === "string" && trigger.script.trim().length > 0)
  );
}

/** Recovers only account authority proven by immutable persisted owner identity. */
function migrateScheduledToolPolicy(
  raw: Record<string, unknown>,
): ScheduledToolPolicyMigrationResult {
  if (!usesToolRuntime(raw)) {
    return {
      mutated: false,
      status: raw.scheduledToolPolicy === undefined ? "not-applicable" : "invalid",
    };
  }
  const payload = readRecord(raw.payload);
  const toolsAllow =
    Array.isArray(payload?.toolsAllow) &&
    payload.toolsAllow.every((value): value is string => typeof value === "string")
      ? payload.toolsAllow
      : undefined;
  const owner = readRecord(raw.owner);
  const ownerSessionKey = normalizeOptionalString(owner?.sessionKey);
  const ownerAccountId = normalizeOptionalAccountId(
    typeof owner?.accountId === "string" ? owner.accountId : undefined,
  );

  if (raw.scheduledToolPolicy !== undefined) {
    const normalized = normalizeCronScheduledToolPolicy(raw.scheduledToolPolicy);
    const resolved = resolveCronScheduledToolPolicy({
      toolsAllow,
      scheduledToolPolicy: normalized,
      owner: { sessionKey: ownerSessionKey, accountId: ownerAccountId },
    });
    if (!resolved) {
      return { mutated: false, status: "invalid" };
    }
    const mutated = JSON.stringify(raw.scheduledToolPolicy) !== JSON.stringify(resolved);
    if (mutated) {
      raw.scheduledToolPolicy = resolved;
    }
    return { mutated, status: "current" };
  }

  // Capless historical jobs have no bounded authority to recover. They remain
  // on legacy sender-policy resolution until an operator explicitly edits tools.
  if (!toolsAllow || !ownerSessionKey) {
    return { mutated: false, status: "legacy" };
  }
  const parsedSession = parseAgentSessionKey(ownerSessionKey);
  if (!parsedSession) {
    return { mutated: false, status: "legacy" };
  }
  const ownerAgentId = normalizeOptionalString(owner?.agentId);
  if (ownerAgentId && normalizeAgentId(ownerAgentId) !== normalizeAgentId(parsedSession.agentId)) {
    return { mutated: false, status: "legacy" };
  }
  const encodedAccountId = normalizeOptionalAccountId(
    parseSessionDeliveryRoute(ownerSessionKey)?.accountId,
  );
  if (ownerAccountId && encodedAccountId && ownerAccountId !== encodedAccountId) {
    return { mutated: false, status: "legacy" };
  }
  const recoveredAccountId = ownerAccountId ?? encodedAccountId;
  if (!recoveredAccountId) {
    return { mutated: false, status: "legacy" };
  }
  const scheduledToolPolicy = createAccountCronScheduledToolPolicy({
    ownerSessionKey,
    ownerAccountId: recoveredAccountId,
  });
  if (!scheduledToolPolicy) {
    return { mutated: false, status: "legacy" };
  }
  raw.owner = {
    ...owner,
    ...(ownerAgentId ? { agentId: normalizeAgentId(ownerAgentId) } : {}),
    sessionKey: ownerSessionKey,
    accountId: recoveredAccountId,
  };
  raw.scheduledToolPolicy = scheduledToolPolicy;
  return { mutated: true, status: "migrated" };
}
