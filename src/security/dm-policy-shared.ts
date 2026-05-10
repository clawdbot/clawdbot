import { resolveGroupAllowFromSources } from "../channels/allow-from.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import { resolveDmAllowAuditState } from "../channels/message-access/dm-allow-state.js";
import {
  readChannelIngressStoreAllowFromForDmPolicy,
  resolveChannelIngressEffectiveAllowFromLists,
} from "../channels/message-access/runtime.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { GroupPolicy } from "../config/types.base.js";
import { evaluateMatchedGroupAccessForPolicy } from "../plugin-sdk/group-access.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

export function resolvePinnedMainDmOwnerFromAllowlist(params: {
  dmScope?: string | null;
  allowFrom?: Array<string | number> | null;
  normalizeEntry: (entry: string) => string | undefined;
}): string | null {
  if ((params.dmScope ?? "main") !== "main") {
    return null;
  }
  const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
  if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) {
    return null;
  }
  const normalizedOwners = Array.from(
    new Set(
      rawAllowFrom
        .map((entry) => params.normalizeEntry(String(entry)))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  return resolveChannelIngressEffectiveAllowFromLists(params);
}

export type DmGroupAccessDecision = "allow" | "block" | "pairing";
export const DM_GROUP_ACCESS_REASON = {
  GROUP_POLICY_ALLOWED: "group_policy_allowed",
  GROUP_POLICY_DISABLED: "group_policy_disabled",
  GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
  GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
  DM_POLICY_OPEN: "dm_policy_open",
  DM_POLICY_DISABLED: "dm_policy_disabled",
  DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
  DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
  DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted",
} as const;
export type DmGroupAccessReasonCode =
  (typeof DM_GROUP_ACCESS_REASON)[keyof typeof DM_GROUP_ACCESS_REASON];
type DmGroupAccessResult = {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};

const dmGroupAccess = (
  decision: DmGroupAccessDecision,
  reasonCode: DmGroupAccessReasonCode,
  reason: string,
): DmGroupAccessResult => ({ decision, reasonCode, reason });

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveOpenDmAllowlistAccess(params: {
  effectiveAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): DmGroupAccessResult {
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  return effectiveAllowFrom.includes("*")
    ? dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN, "dmPolicy=open")
    : params.isSenderAllowed(effectiveAllowFrom)
      ? dmGroupAccess(
          "allow",
          DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
          "dmPolicy=open (allowlisted)",
        )
      : dmGroupAccess(
          "block",
          DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
          "dmPolicy=open (not allowlisted)",
        );
}

type DmGroupAccessInputParams = {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
  isSenderAllowed: (allowFrom: string[]) => boolean;
};

const GROUP_ACCESS_RESULT: Record<
  Exclude<ReturnType<typeof evaluateMatchedGroupAccessForPolicy>["reason"], "allowed">,
  DmGroupAccessResult
> = {
  disabled: dmGroupAccess(
    "block",
    DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED,
    "groupPolicy=disabled",
  ),
  empty_allowlist: dmGroupAccess(
    "block",
    DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
    "groupPolicy=allowlist (empty allowlist)",
  ),
  missing_match_input: dmGroupAccess(
    "block",
    DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
    "groupPolicy=allowlist (not allowlisted)",
  ),
  not_allowlisted: dmGroupAccess(
    "block",
    DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
    "groupPolicy=allowlist (not allowlisted)",
  ),
};

/** @deprecated Use `resolveChannelMessageIngress` or `readChannelIngressStoreAllowFromForDmPolicy` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function readStoreAllowFromForDmPolicy(params: {
  provider: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  return await readChannelIngressStoreAllowFromForDmPolicy(params);
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveDmGroupAccessDecision(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  effectiveAllowFrom: Array<string | number>;
  effectiveGroupAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): DmGroupAccessResult {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const groupPolicy: GroupPolicy =
    params.groupPolicy === "open" || params.groupPolicy === "disabled"
      ? params.groupPolicy
      : "allowlist";
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);

  if (params.isGroup) {
    const groupAccess = evaluateMatchedGroupAccessForPolicy({
      groupPolicy,
      allowlistConfigured: effectiveGroupAllowFrom.length > 0,
      allowlistMatched: params.isSenderAllowed(effectiveGroupAllowFrom),
    });
    if (groupAccess.allowed) {
      return dmGroupAccess(
        "allow",
        DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
        `groupPolicy=${groupPolicy}`,
      );
    }
    switch (groupAccess.reason) {
      case "disabled":
      case "empty_allowlist":
      case "missing_match_input":
      case "not_allowlisted":
        return GROUP_ACCESS_RESULT[groupAccess.reason];
      case "allowed":
        return dmGroupAccess(
          "allow",
          DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
          `groupPolicy=${groupPolicy}`,
        );
    }
  }

  if (dmPolicy === "disabled") {
    return dmGroupAccess("block", DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED, "dmPolicy=disabled");
  }
  if (dmPolicy === "open") {
    return resolveOpenDmAllowlistAccess({
      effectiveAllowFrom,
      isSenderAllowed: params.isSenderAllowed,
    });
  }
  return params.isSenderAllowed(effectiveAllowFrom)
    ? dmGroupAccess(
        "allow",
        DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
        `dmPolicy=${dmPolicy} (allowlisted)`,
      )
    : dmPolicy === "pairing"
      ? dmGroupAccess(
          "pairing",
          DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
          "dmPolicy=pairing (not allowlisted)",
        )
      : dmGroupAccess(
          "block",
          DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
          `dmPolicy=${dmPolicy} (not allowlisted)`,
        );
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveDmGroupAccessWithLists(params: DmGroupAccessInputParams): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
  });
  const access = resolveDmGroupAccessDecision({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    isSenderAllowed: params.isSenderAllowed,
  });
  return {
    ...access,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
  };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveDmGroupAccessWithCommandGate(
  params: DmGroupAccessInputParams & {
    command?: {
      useAccessGroups: boolean;
      allowTextCommands: boolean;
      hasControlCommand: boolean;
    };
  },
): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
} {
  const access = resolveDmGroupAccessWithLists({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
    isSenderAllowed: params.isSenderAllowed,
  });

  const configuredAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
  const configuredGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom: configuredAllowFrom,
      groupAllowFrom: normalizeStringEntries(params.groupAllowFrom ?? []),
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
    }),
  );
  // Group command authorization must not inherit DM pairing-store approvals.
  const commandDmAllowFrom = params.isGroup ? configuredAllowFrom : access.effectiveAllowFrom;
  const commandGroupAllowFrom = params.isGroup
    ? configuredGroupAllowFrom
    : access.effectiveGroupAllowFrom;
  const commandGate = params.command
    ? resolveControlCommandGate({
        useAccessGroups: params.command.useAccessGroups,
        authorizers: [
          {
            configured: commandDmAllowFrom.length > 0,
            allowed: params.isSenderAllowed(commandDmAllowFrom),
          },
          {
            configured: commandGroupAllowFrom.length > 0,
            allowed: params.isSenderAllowed(commandGroupAllowFrom),
          },
        ],
        allowTextCommands: params.command.allowTextCommands,
        hasControlCommand: params.command.hasControlCommand,
      })
    : { commandAuthorized: false, shouldBlock: false };

  return {
    ...access,
    commandAuthorized: commandGate.commandAuthorized,
    shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock,
  };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function resolveDmAllowState(params: {
  provider: ChannelId;
  accountId: string;
  allowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
  configAllowFrom: string[];
  hasWildcard: boolean;
  allowCount: number;
  isMultiUserDm: boolean;
}> {
  return await resolveDmAllowAuditState(params);
}
