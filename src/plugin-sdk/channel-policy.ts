import { createAllowlistProviderRestrictSendersWarningCollector } from "../channels/plugins/group-policy-warnings.js";
import type { ChannelSecurityAdapter } from "../channels/plugins/types.adapters.js";
import { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
import type { GroupPolicy } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { createScopedDmSecurityResolver } from "./channel-config-helpers.js";
/** Shared policy warnings and DM/group policy helpers for channel plugins. */
export type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "../config/types.tools.js";
export {
  composeAccountWarningCollectors,
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  composeWarningCollectors,
  createAllowlistProviderGroupPolicyWarningCollector,
  createConditionalWarningCollector,
  createAllowlistProviderOpenWarningCollector,
  createAllowlistProviderRouteAllowlistWarningCollector,
  createOpenGroupPolicyRestrictSendersWarningCollector,
  createOpenProviderGroupPolicyWarningCollector,
  createOpenProviderConfiguredRouteWarningCollector,
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
  collectAllowlistProviderGroupPolicyWarnings,
  collectAllowlistProviderRestrictSendersWarnings,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  collectOpenGroupPolicyRestrictSendersWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  collectOpenProviderGroupPolicyWarnings,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
  projectConfigAccountIdWarningCollector,
  projectConfigWarningCollector,
  projectWarningCollector,
} from "../channels/plugins/group-policy-warnings.js";
export { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
export {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  resolveToolsBySender,
  type ChannelGroupPolicy,
} from "../config/group-policy.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolveOpenDmAllowlistAccess,
} from "./channel-access-compat.js";
export {
  evaluateGroupRouteAccessForPolicy,
  evaluateSenderGroupAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export { createAllowlistProviderRestrictSendersWarningCollector };

export function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((value) => String(value).trim()).filter(Boolean);
}

export function coerceNativeSetting(value: unknown): boolean | "auto" | undefined {
  if (value === true || value === false || value === "auto") {
    return value;
  }
  return undefined;
}

export type ChannelMutableAllowlistCandidate = {
  pathLabel: string;
  list: unknown;
};

type ChannelMutableAllowlistHit = {
  path: string;
  entry: string;
  dangerousFlagPath: string;
};

function collectMutableAllowlistWarningLines(
  hits: ChannelMutableAllowlistHit[],
  channel: string,
): string[] {
  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  const flagPaths = Array.from(new Set(hits.map((hit) => hit.dangerousFlagPath)));
  const flagHint =
    flagPaths.length === 1
      ? sanitizeForLog(flagPaths[0] ?? "")
      : `${sanitizeForLog(flagPaths[0] ?? "")} (and ${flagPaths.length - 1} other scope flags)`;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across ${channel} while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    `- Option A (break-glass): enable ${flagHint}=true to keep name/email/nick matching.`,
    "- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries.",
  ];
}

export function createDangerousNameMatchingMutableAllowlistWarningCollector(params: {
  channel: string;
  detector: (entry: string) => boolean;
  collectLists: (scope: {
    prefix: string;
    account: Record<string, unknown>;
    dangerousFlagPath: string;
  }) => ChannelMutableAllowlistCandidate[];
}) {
  return ({ cfg }: { cfg: OpenClawConfig }): string[] => {
    const hits: ChannelMutableAllowlistHit[] = [];
    for (const scope of collectProviderDangerousNameMatchingScopes(cfg, params.channel)) {
      if (scope.dangerousNameMatchingEnabled) {
        continue;
      }
      for (const candidate of params.collectLists(scope)) {
        if (!Array.isArray(candidate.list)) {
          continue;
        }
        for (const entry of candidate.list) {
          const text = String(entry).trim();
          if (!text || text === "*" || !params.detector(text)) {
            continue;
          }
          hits.push({
            path: candidate.pathLabel,
            entry: text,
            dangerousFlagPath: scope.dangerousFlagPath,
          });
        }
      }
    }
    return collectMutableAllowlistWarningLines(hits, params.channel);
  };
}

/** Compose the common DM policy resolver with restrict-senders group warnings. */
export function createRestrictSendersChannelSecurity<
  ResolvedAccount extends { accountId?: string | null },
>(params: {
  channelKey: string;
  resolveDmPolicy: (account: ResolvedAccount) => string | null | undefined;
  resolveDmAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
  providerConfigPresent?: (cfg: OpenClawConfig) => boolean;
  resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
  defaultDmPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeDmEntry?: (raw: string) => string;
  inheritSharedDefaultsFromDefaultAccount?: boolean;
}): ChannelSecurityAdapter<ResolvedAccount> {
  return {
    resolveDmPolicy: createScopedDmSecurityResolver<ResolvedAccount>({
      channelKey: params.channelKey,
      resolvePolicy: params.resolveDmPolicy,
      resolveAllowFrom: params.resolveDmAllowFrom,
      resolveFallbackAccountId: params.resolveFallbackAccountId,
      defaultPolicy: params.defaultDmPolicy,
      allowFromPathSuffix: params.allowFromPathSuffix,
      policyPathSuffix: params.policyPathSuffix,
      approveChannelId: params.approveChannelId,
      approveHint: params.approveHint,
      normalizeEntry: params.normalizeDmEntry,
      inheritSharedDefaultsFromDefaultAccount: params.inheritSharedDefaultsFromDefaultAccount,
    }),
    collectWarnings: createAllowlistProviderRestrictSendersWarningCollector<ResolvedAccount>({
      providerConfigPresent:
        params.providerConfigPresent ?? ((cfg) => cfg.channels?.[params.channelKey] !== undefined),
      resolveGroupPolicy: params.resolveGroupPolicy,
      surface: params.surface,
      openScope: params.openScope,
      groupPolicyPath: params.groupPolicyPath,
      groupAllowFromPath: params.groupAllowFromPath,
      mentionGated: params.mentionGated,
    }),
  };
}
