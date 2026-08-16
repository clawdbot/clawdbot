import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  type ChannelDmAllowFromMode,
  resolveChannelDmAllowFrom,
  resolveChannelDmPolicy,
} from "../channels/plugins/dm-access.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { isRecord } from "../utils.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import {
  type DmPolicyAllowFromViolation,
  evaluateDmPolicyAllowFromDependency,
} from "./zod-schema.core.js";

export const bundledChannelSchemaById = new Map<string, unknown>(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false).map(
    (entry) => [entry.channelId, entry.schema] as const,
  ),
);

export const bundledChannelIds = Object.freeze(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false)
    .map((entry) => normalizeLowercaseStringOrEmpty(entry.channelId))
    .filter((channelId) => channelId.length > 0),
);

const bundledChannelIdSet = new Set(bundledChannelIds);
const bundledChannelAliases = new Map<string, string>(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false).flatMap(
    (entry) => {
      const channelId = normalizeLowercaseStringOrEmpty(entry.channelId);
      if (!channelId) {
        return [];
      }
      return (entry.aliases ?? [])
        .map((alias) => [normalizeLowercaseStringOrEmpty(alias), channelId] as const)
        .filter(([alias]) => alias.length > 0);
    },
  ),
);

export function normalizeBundledChannelId(raw?: string | null): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (!normalized) {
    return null;
  }
  const resolved = bundledChannelAliases.get(normalized) ?? normalized;
  return bundledChannelIdSet.has(resolved) ? resolved : null;
}

export function formatRawChannelConfigIssueMessage(message: string): string {
  return `invalid config: ${message}`;
}

function buildDmPolicyDependencyWarning(params: {
  channelId: string;
  accountId?: string;
  allowFromSource?: "explicit" | "inherited";
  violation: DmPolicyAllowFromViolation;
}): ConfigValidationIssue {
  const channelBase = `channels.${params.channelId}`;
  const scope = params.accountId ? `${channelBase}.accounts.${params.accountId}` : channelBase;
  const allowFromPath = `${scope}.allowFrom`;
  const inherited = params.accountId && params.allowFromSource === "inherited";
  const allowFromSubject = inherited
    ? `${allowFromPath} is unset and ${channelBase}.allowFrom`
    : allowFromPath;
  const accountInheritedTarget = inherited ? ` or ${channelBase}.allowFrom` : "";
  const accountOverrideFix =
    params.accountId && !inherited
      ? `, remove ${allowFromPath} to inherit ${channelBase}.allowFrom,`
      : "";
  const message =
    params.violation === "open_requires_wildcard"
      ? `${scope}.dmPolicy="open" but ${allowFromSubject} does not include "*"; all DMs will be dropped. Add "*" to ${allowFromPath}${accountInheritedTarget}${accountOverrideFix} or set ${scope}.dmPolicy to "pairing"/"allowlist".`
      : `${scope}.dmPolicy="allowlist" but ${allowFromSubject} is empty; all DMs will be dropped. Add at least one sender ID to ${allowFromPath}${accountInheritedTarget}${accountOverrideFix} or change ${scope}.dmPolicy.`;
  return { path: allowFromPath, message };
}

// Channel map keys that are not channels and must be skipped while scanning DM policy.
const DM_POLICY_PSEUDO_CHANNEL_KEYS = new Set(["defaults", "modelByChannel", "tools"]);

function hasDefinedConfigValue(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function hasConfiguredDmAllowFrom(
  record: Record<string, unknown>,
  mode: ChannelDmAllowFromMode,
): boolean {
  const dm = isRecord(record.dm) ? record.dm : null;
  if (mode === "nestedOnly") {
    return (
      (dm !== null && hasDefinedConfigValue(dm, "allowFrom")) ||
      hasDefinedConfigValue(record, "allowFrom")
    );
  }
  return (
    hasDefinedConfigValue(record, "allowFrom") ||
    (dm !== null && hasDefinedConfigValue(dm, "allowFrom"))
  );
}

function isConfigRecordEnabled(record: Record<string, unknown>): boolean {
  return record.enabled !== false;
}

export function hasChannelDmPolicyDependencyWarningCandidates(config: OpenClawConfig): boolean {
  if (!config.channels || !isRecord(config.channels)) {
    return false;
  }
  return Object.entries(config.channels).some(
    ([channelId, channelValue]) =>
      !DM_POLICY_PSEUDO_CHANNEL_KEYS.has(channelId) &&
      isRecord(channelValue) &&
      isConfigRecordEnabled(channelValue),
  );
}

/**
 * Surface dmPolicy/allowFrom dependency problems generically for every channel that
 * exposes DM policy via the canonical top-level `dmPolicy`/`allowFrom` fields. These
 * configs parse fine but drop every DM at runtime, so we warn (rather than reject) to
 * stay consistent with `security audit`/`doctor` and avoid breaking existing-but-usable
 * configs on upgrade.
 *
 * Resolution goes through the shared DM-access helpers so the warning matches the
 * effective policy/allowFrom the runtime sees, including the legacy `dm.*` aliases and
 * account->channel inheritance. `nestedOnly` channels (canonical fields under `dm.*`)
 * are skipped because their config shape does not match this warning's top-level paths.
 */
export function collectChannelDmPolicyDependencyWarnings(
  config: OpenClawConfig,
  options: { dmAllowFromModes?: ReadonlyMap<string, ChannelDmAllowFromMode> } = {},
): ConfigValidationIssue[] {
  if (!config.channels || !isRecord(config.channels)) {
    return [];
  }
  const warnings: ConfigValidationIssue[] = [];
  for (const [channelId, channelValue] of Object.entries(config.channels)) {
    if (
      DM_POLICY_PSEUDO_CHANNEL_KEYS.has(channelId) ||
      !isRecord(channelValue) ||
      !isConfigRecordEnabled(channelValue)
    ) {
      continue;
    }
    const mode = options.dmAllowFromModes?.get(channelId) ?? "topOnly";
    if (mode === "nestedOnly") {
      continue;
    }
    const channelViolation = evaluateDmPolicyAllowFromDependency({
      policy: resolveChannelDmPolicy({ account: channelValue, mode }),
      allowFrom: resolveChannelDmAllowFrom({ account: channelValue, mode }),
    });
    if (channelViolation) {
      warnings.push(buildDmPolicyDependencyWarning({ channelId, violation: channelViolation }));
    }
    if (!isRecord(channelValue.accounts)) {
      continue;
    }
    for (const [accountId, accountValue] of Object.entries(channelValue.accounts)) {
      if (!isRecord(accountValue) || !isConfigRecordEnabled(accountValue)) {
        continue;
      }
      const allowFromSource = hasConfiguredDmAllowFrom(accountValue, mode)
        ? "explicit"
        : "inherited";
      const accountViolation = evaluateDmPolicyAllowFromDependency({
        policy: resolveChannelDmPolicy({ account: accountValue, parent: channelValue, mode }),
        allowFrom: resolveChannelDmAllowFrom({ account: accountValue, parent: channelValue, mode }),
      });
      if (accountViolation) {
        warnings.push(
          buildDmPolicyDependencyWarning({
            channelId,
            accountId,
            allowFromSource,
            violation: accountViolation,
          }),
        );
      }
    }
  }
  return warnings;
}

export function collectRawBundledChannelConfigIssues(
  config: OpenClawConfig,
): ConfigValidationIssue[] {
  if (!config.channels || !isRecord(config.channels)) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const [channelId, schema] of bundledChannelSchemaById) {
    if (!Object.hasOwn(config.channels, channelId)) {
      continue;
    }
    const result = validateJsonSchemaValue({
      schema: schema as Record<string, unknown>,
      cacheKey: `raw-channel:${channelId}`,
      value: config.channels[channelId],
      applyDefaults: false,
    });
    if (result.ok) {
      continue;
    }
    for (const error of result.errors) {
      const message = error.additionalProperty
        ? `${error.message}: "${error.additionalProperty}"`
        : error.message;
      const path =
        error.path === "<root>" ? `channels.${channelId}` : `channels.${channelId}.${error.path}`;
      issues.push({
        path,
        message: formatRawChannelConfigIssueMessage(message),
        allowedValues: error.allowedValues,
        allowedValuesHiddenCount: error.allowedValuesHiddenCount,
      });
    }
  }
  return issues;
}
