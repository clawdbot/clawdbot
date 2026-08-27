/**
 * Channel ingress allowlist diagnostics.
 *
 * Merges allowlists, applies identifier authentication policy, and redacts access-graph facts.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  meetsIdentifierAuthentication,
  minimumIdentifierAuthenticationFrom,
  weakestIdentifierAuthentication,
} from "./identifier-authentication.js";
import type {
  ChannelIngressPolicyInput,
  NormalizedIngressState,
  IngressReasonCode,
  RedactedIngressAllowlistFacts,
  RedactedIngressEntryDiagnostic,
  NormalizedIngressAllowlist,
} from "./types.js";

/**
 * Returns the first access-group related failure reason for an allowlist.
 */
export function allowlistFailureReason(
  allowlist: NormalizedIngressAllowlist,
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
  allowlist: NormalizedIngressAllowlist,
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
  allowlists: readonly NormalizedIngressAllowlist[],
): NormalizedIngressAllowlist {
  const scopedAllowlists: NormalizedIngressAllowlist[] = [];
  for (const [index, allowlist] of allowlists.entries()) {
    const prefix = `source-${index + 1}:`;
    const normalizedEntries = [];
    for (const entry of allowlist.normalizedEntries) {
      normalizedEntries.push({ ...entry, opaqueEntryId: `${prefix}${entry.opaqueEntryId}` });
    }
    const matchedPairs = [];
    for (const pair of allowlist.match.matchedPairs ?? []) {
      matchedPairs.push({ ...pair, opaqueEntryId: `${prefix}${pair.opaqueEntryId}` });
    }
    const matchedEntryIds = allowlist.matchedEntryIds.map((id) => `${prefix}${id}`);
    scopedAllowlists.push({
      ...allowlist,
      normalizedEntries,
      matchedEntryIds,
      match: {
        ...allowlist.match,
        matchedEntryIds,
        ...(matchedPairs.length > 0 ? { matchedPairs } : {}),
      },
    });
  }
  const matches = scopedAllowlists.map((allowlist) => allowlist.match);
  const matchedEntryIds = uniqueStrings(
    scopedAllowlists.flatMap((allowlist) => allowlist.matchedEntryIds),
  );
  const matchedPairs = scopedAllowlists.flatMap((allowlist) => allowlist.match.matchedPairs ?? []);
  return {
    rawEntryCount: scopedAllowlists.reduce((sum, allowlist) => sum + allowlist.rawEntryCount, 0),
    normalizedEntries: scopedAllowlists.flatMap((allowlist) => allowlist.normalizedEntries),
    invalidEntries: scopedAllowlists.flatMap((allowlist) => allowlist.invalidEntries),
    disabledEntries: scopedAllowlists.flatMap((allowlist) => allowlist.disabledEntries),
    matchedEntryIds,
    hasConfiguredEntries: scopedAllowlists.some((allowlist) => allowlist.hasConfiguredEntries),
    hasMatchableEntries: scopedAllowlists.some((allowlist) => allowlist.hasMatchableEntries),
    hasWildcard: scopedAllowlists.some((allowlist) => allowlist.hasWildcard),
    accessGroups: {
      referenced: uniqueStrings(
        scopedAllowlists.flatMap((allowlist) => allowlist.accessGroups.referenced),
      ),
      matched: uniqueStrings(
        scopedAllowlists.flatMap((allowlist) => allowlist.accessGroups.matched),
      ),
      missing: uniqueStrings(
        scopedAllowlists.flatMap((allowlist) => allowlist.accessGroups.missing),
      ),
      unsupported: uniqueStrings(
        scopedAllowlists.flatMap((allowlist) => allowlist.accessGroups.unsupported),
      ),
      failed: uniqueStrings(scopedAllowlists.flatMap((allowlist) => allowlist.accessGroups.failed)),
    },
    match: {
      matched: matches.some((match) => match.matched) || matchedEntryIds.length > 0,
      matchedEntryIds,
      ...(matchedPairs.length > 0 ? { matchedPairs } : {}),
    },
  };
}

/**
 * Applies identifier authentication to exact matched entry/subject pairs.
 */
export function applyIdentifierAuthenticationPolicy(
  allowlist: NormalizedIngressAllowlist,
  policy: ChannelIngressPolicyInput,
): NormalizedIngressAllowlist {
  const minimum = minimumIdentifierAuthenticationFrom(policy);
  const pairsByEntry = new Map<string, NonNullable<typeof allowlist.match.matchedPairs>>();
  for (const pair of allowlist.match.matchedPairs ?? []) {
    const pairs = pairsByEntry.get(pair.opaqueEntryId) ?? [];
    pairs.push(pair);
    pairsByEntry.set(pair.opaqueEntryId, pairs);
  }
  const rejectedEntryIds = new Set<string>();
  for (const entry of allowlist.normalizedEntries) {
    const pairs = pairsByEntry.get(entry.opaqueEntryId);
    const pairStrengths = pairs?.map((pair) =>
      weakestIdentifierAuthentication(entry.authentication, pair.subjectAuthentication),
    );
    const accepted =
      pairStrengths && pairStrengths.length > 0
        ? pairStrengths.some((strength) => meetsIdentifierAuthentication(strength, minimum))
        : meetsIdentifierAuthentication(entry.authentication, minimum);
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
          entry.authentication === "mutable"
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
        Boolean(allowlist.match.matchedPairs?.length),
      threshold: minimum,
      affectedMatch,
      rejectedEntryIds: [...rejectedEntryIds],
    },
  };
}

/**
 * Resolves the sender allowlist used for group/channel ingress after route overrides.
 */
export function effectiveGroupSenderAllowlist(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
}): NormalizedIngressAllowlist {
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
