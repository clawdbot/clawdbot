import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
import { shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning } from "./channel-doctor.js";

type CollectEmptyAllowlistPolicyWarningsParams = {
  account: DoctorAccountRecord;
  channelName?: string;
  cfg?: OpenClawConfig;
  doctorFixCommand: string;
  parent?: DoctorAccountRecord;
  prefix: string;
  shouldSkipDefaultEmptyGroupAllowlistWarning?: typeof shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning;
};

function usesSenderBasedGroupAllowlist(channelName?: string): boolean {
  return getDoctorChannelCapabilities(channelName).warnOnEmptyGroupSenderAllowlist;
}

function allowsGroupAllowFromFallback(channelName?: string): boolean {
  return getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom;
}

export function collectEmptyAllowlistPolicyWarningsForAccount(
  params: CollectEmptyAllowlistPolicyWarningsParams,
): string[] {
  const warnings: string[] = [];
  const dmEntry = params.account.dm;
  const dm =
    dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
      ? (dmEntry as DoctorAccountRecord)
      : undefined;
  const parentDmEntry = params.parent?.dm;
  const parentDm =
    parentDmEntry && typeof parentDmEntry === "object" && !Array.isArray(parentDmEntry)
      ? (parentDmEntry as DoctorAccountRecord)
      : undefined;
  const dmPolicy =
    (params.account.dmPolicy as string | undefined) ??
    (dm?.policy as string | undefined) ??
    (params.parent?.dmPolicy as string | undefined) ??
    (parentDm?.policy as string | undefined) ??
    undefined;

  const topAllowFrom =
    (params.account.allowFrom as DoctorAllowFromList | undefined) ??
    (params.parent?.allowFrom as DoctorAllowFromList | undefined);
  const nestedAllowFrom = dm?.allowFrom as DoctorAllowFromList | undefined;
  const parentNestedAllowFrom = parentDm?.allowFrom as DoctorAllowFromList | undefined;
  const effectiveAllowFrom = topAllowFrom ?? nestedAllowFrom ?? parentNestedAllowFrom;

  if (dmPolicy === "allowlist" && !hasAllowFromEntries(effectiveAllowFrom)) {
    warnings.push(
      `- ${params.prefix}.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to ${params.prefix}.allowFrom, or run "${params.doctorFixCommand}" to auto-migrate from pairing store when entries exist.`,
    );
  }

  const groupPolicy =
    (params.account.groupPolicy as string | undefined) ??
    (params.parent?.groupPolicy as string | undefined) ??
    undefined;

  if (groupPolicy !== "allowlist" || !usesSenderBasedGroupAllowlist(params.channelName)) {
    return warnings;
  }

  if (
    params.channelName &&
    (
      params.shouldSkipDefaultEmptyGroupAllowlistWarning ??
      shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning
    )({
      account: params.account,
      channelName: params.channelName,
      cfg: params.cfg,
      dmPolicy,
      effectiveAllowFrom,
      parent: params.parent,
      prefix: params.prefix,
    })
  ) {
    return warnings;
  }

  const rawGroupAllowFrom =
    (params.account.groupAllowFrom as DoctorAllowFromList | undefined) ??
    (params.parent?.groupAllowFrom as DoctorAllowFromList | undefined);
  // Match runtime semantics: resolveGroupAllowFromSources treats empty arrays as
  // unset and falls back to allowFrom.
  const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
  const fallbackToAllowFrom = allowsGroupAllowFromFallback(params.channelName);
  const effectiveGroupAllowFrom =
    groupAllowFrom ?? (fallbackToAllowFrom ? effectiveAllowFrom : undefined);

  if (hasAllowFromEntries(effectiveGroupAllowFrom)) {
    return warnings;
  }

  if (fallbackToAllowFrom) {
    warnings.push(
      `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom or ${params.prefix}.allowFrom, or set groupPolicy to "open".`,
    );
  } else {
    warnings.push(
      `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom, or set groupPolicy to "open".`,
    );
  }

  return warnings;
}
