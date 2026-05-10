import type {
  ChannelIngressPolicyInput,
  ChannelIngressState,
  IngressReasonCode,
  RedactedIngressAllowlistFacts,
  RedactedIngressEntryDiagnostic,
  ResolvedIngressAllowlist,
} from "./types.js";

export function allowlistFailureReason(
  allowlist: ResolvedIngressAllowlist,
): IngressReasonCode | null {
  if (allowlist.accessGroups.failed.length > 0) {
    return "access_group_failed";
  }
  if (allowlist.accessGroups.unsupported.length > 0) {
    return "access_group_unsupported";
  }
  if (allowlist.accessGroups.missing.length > 0) {
    return "access_group_missing";
  }
  return null;
}

export function redactedAllowlistDiagnostics(
  allowlist: ResolvedIngressAllowlist,
  reasonCode: IngressReasonCode,
): RedactedIngressAllowlistFacts {
  return {
    configured: allowlist.hasConfiguredEntries,
    matched: allowlist.match.matched,
    reasonCode,
    matchedEntryIds: allowlist.matchedEntryIds,
    invalidEntryCount: allowlist.invalidEntries.length,
    disabledEntryCount: allowlist.disabledEntries.length,
    accessGroups: allowlist.accessGroups,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function mergeResolvedAllowlists(
  allowlists: readonly ResolvedIngressAllowlist[],
): ResolvedIngressAllowlist {
  const matches = allowlists.map((allowlist) => allowlist.match);
  const matchedEntryIds = uniqueStrings(
    allowlists.flatMap((allowlist) => allowlist.matchedEntryIds),
  );
  return {
    rawEntryCount: allowlists.reduce((sum, allowlist) => sum + allowlist.rawEntryCount, 0),
    normalizedEntries: allowlists.flatMap((allowlist) => allowlist.normalizedEntries),
    invalidEntries: allowlists.flatMap((allowlist) => allowlist.invalidEntries),
    disabledEntries: allowlists.flatMap((allowlist) => allowlist.disabledEntries),
    matchedEntryIds,
    hasConfiguredEntries: allowlists.some((allowlist) => allowlist.hasConfiguredEntries),
    hasMatchableEntries: allowlists.some((allowlist) => allowlist.hasMatchableEntries),
    hasWildcard: allowlists.some((allowlist) => allowlist.hasWildcard),
    accessGroups: {
      referenced: uniqueStrings(
        allowlists.flatMap((allowlist) => allowlist.accessGroups.referenced),
      ),
      matched: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.matched)),
      missing: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.missing)),
      unsupported: uniqueStrings(
        allowlists.flatMap((allowlist) => allowlist.accessGroups.unsupported),
      ),
      failed: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.failed)),
    },
    match: {
      matched: matches.some((match) => match.matched) || matchedEntryIds.length > 0,
      matchedEntryIds,
    },
  };
}

export function applyMutableIdentifierPolicy(
  allowlist: ResolvedIngressAllowlist,
  policy: ChannelIngressPolicyInput,
): ResolvedIngressAllowlist {
  if (policy.mutableIdentifierMatching === "enabled") {
    return allowlist;
  }
  const dangerousEntryIds = new Set(
    allowlist.normalizedEntries
      .filter((entry) => entry.dangerous)
      .map((entry) => entry.opaqueEntryId),
  );
  if (dangerousEntryIds.size === 0) {
    return allowlist;
  }
  const matchedEntryIds = allowlist.matchedEntryIds.filter((id) => !dangerousEntryIds.has(id));
  const disabledEntries: RedactedIngressEntryDiagnostic[] = [
    ...allowlist.disabledEntries,
    ...allowlist.normalizedEntries
      .filter((entry) => entry.dangerous)
      .map((entry) => ({
        opaqueEntryId: entry.opaqueEntryId,
        reasonCode: "mutable_identifier_disabled" as const,
      })),
  ];
  return {
    ...allowlist,
    disabledEntries,
    matchedEntryIds,
    hasMatchableEntries: allowlist.normalizedEntries.some((entry) => !entry.dangerous),
    match: {
      matched: matchedEntryIds.length > 0,
      matchedEntryIds,
    },
  };
}

export function effectiveGroupSenderAllowlist(params: {
  state: ChannelIngressState;
  policy: ChannelIngressPolicyInput;
}): ResolvedIngressAllowlist {
  let effective =
    params.policy.groupAllowFromFallbackToAllowFrom &&
    !params.state.allowlists.group.hasConfiguredEntries
      ? params.state.allowlists.dm
      : params.state.allowlists.group;
  for (const route of params.state.routeFacts) {
    if (route.gate !== "matched" || !route.senderAllowlist) {
      continue;
    }
    if (route.senderPolicy === "inherit") {
      effective = mergeResolvedAllowlists([effective, route.senderAllowlist]);
      continue;
    }
    effective = route.senderAllowlist;
  }
  return applyMutableIdentifierPolicy(effective, params.policy);
}
