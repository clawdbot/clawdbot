/**
 * Channel ingress allowlist diagnostics.
 *
 * Merges allowlists, applies mutable identifier policy, and redacts access-graph facts.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  identifierAuthenticationFrom,
  meetsIdentifierAuthentication,
  minimumIdentifierAuthenticationFrom,
  weakestIdentifierAuthentication,
} from "./identifier-authentication.js";
import type {
  ChannelIngressPolicyInput,
  ChannelIngressState,
  IngressReasonCode,
  RedactedIngressAllowlistFacts,
  RedactedIngressEntryDiagnostic,
  ResolvedIngressAllowlist,
} from "./types.js";

/**
 * Returns the first access-group related failure reason for an allowlist.
 */
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

/**
 * Projects an allowlist into redacted diagnostics safe for ingress access graphs.
 */
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

/**
 * Applies identifier authentication to exact matched entry/subject pairs.
 */
function applyIdentifierAuthenticationPolicy(
  allowlist: ResolvedIngressAllowlist,
  policy: ChannelIngressPolicyInput,
): ResolvedIngressAllowlist {
  const minimum = minimumIdentifierAuthenticationFrom(policy);
  const pairsByEntry = new Map<string, NonNullable<typeof allowlist.match.matchedPairs>>();
  for (const pair of allowlist.match.matchedPairs ?? []) {
    const pairs = pairsByEntry.get(pair.opaqueEntryId) ?? [];
    pairs.push(pair);
    pairsByEntry.set(pair.opaqueEntryId, pairs);
  }
  const rejectedEntryIds = new Set<string>();
  for (const entry of allowlist.normalizedEntries) {
    const entryAuthentication = identifierAuthenticationFrom(entry);
    const pairs = pairsByEntry.get(entry.opaqueEntryId);
    const pairStrengths = pairs?.map((pair) =>
      pair.subjectAuthentication
        ? weakestIdentifierAuthentication(entryAuthentication, pair.subjectAuthentication)
        : entryAuthentication,
    );
    const accepted =
      pairStrengths && pairStrengths.length > 0
        ? pairStrengths.some((strength) => meetsIdentifierAuthentication(strength, minimum))
        : meetsIdentifierAuthentication(entryAuthentication, minimum);
    if (!accepted) {
      rejectedEntryIds.add(entry.opaqueEntryId);
    }
  }
  const matchedEntryIds = allowlist.matchedEntryIds.filter((id) => !rejectedEntryIds.has(id));
  const matchedPairs = allowlist.match.matchedPairs?.filter(
    (pair) => !rejectedEntryIds.has(pair.opaqueEntryId),
  );
  const disabledEntries: RedactedIngressEntryDiagnostic[] = [
    ...allowlist.disabledEntries,
    ...allowlist.normalizedEntries
      .filter((entry) => rejectedEntryIds.has(entry.opaqueEntryId))
      .map((entry) => ({
        opaqueEntryId: entry.opaqueEntryId,
        reasonCode:
          identifierAuthenticationFrom(entry) === "mutable"
            ? ("mutable_identifier_disabled" as const)
            : ("identifier_authentication_too_weak" as const),
      })),
  ];
  const affectedMatch = matchedEntryIds.length !== allowlist.matchedEntryIds.length;
  return {
    ...allowlist,
    disabledEntries,
    matchedEntryIds,
    hasMatchableEntries: allowlist.normalizedEntries.some(
      (entry) => !rejectedEntryIds.has(entry.opaqueEntryId),
    ),
    match: {
      matched: matchedEntryIds.length > 0,
      matchedEntryIds,
      ...(matchedPairs ? { matchedPairs } : {}),
    },
    authentication: {
      evaluated:
        policy.minIdentifierAuthentication !== undefined ||
        policy.mutableIdentifierMatching !== undefined ||
        (allowlist.match.matchedPairs?.some((pair) => pair.subjectAuthentication !== undefined) ??
          false),
      threshold: minimum,
      affectedMatch,
      rejectedEntryIds: [...rejectedEntryIds],
    },
  };
}

/** @deprecated Use `applyIdentifierAuthenticationPolicy`. */
export function applyMutableIdentifierPolicy(
  allowlist: ResolvedIngressAllowlist,
  policy: ChannelIngressPolicyInput,
): ResolvedIngressAllowlist {
  return applyIdentifierAuthenticationPolicy(allowlist, policy);
}

/**
 * Resolves the sender allowlist used for group/channel ingress after route overrides.
 */
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
    // Route sender policies other than inherit replace the channel-level sender allowlist.
    effective = route.senderAllowlist;
  }
  return applyIdentifierAuthenticationPolicy(effective, params.policy);
}
