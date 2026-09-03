/**
 * Channel ingress state resolver.
 *
 * Normalizes and matches route, sender, command, and access-group allowlists.
 */
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { parseAccessGroupAllowFromEntry } from "../allow-from.js";
import {
  identifierAuthenticationFrom,
  weakestIdentifierAuthentication,
  type IdentifierAuthentication,
} from "./identifier-authentication.js";
import type {
  AccessGroupMembershipFact,
  NormalizedIngressState,
  ChannelIngressStateInput,
  InternalChannelIngressAdapter,
  InternalChannelIngressSubject,
  NormalizedIngressSubject,
  NormalizedIngressEntry,
  RedactedIngressEntryDiagnostic,
  RedactedIngressMatch,
  NormalizedIngressAllowlist,
} from "./types.js";

type NormalizedStateInput = Omit<ChannelIngressStateInput, "subject" | "event"> & {
  subject: NormalizedIngressSubject;
  event: Omit<ChannelIngressStateInput["event"], "originSubject"> & {
    originSubject?: NormalizedIngressSubject;
  };
};

function normalizeSubjectAuthentication(
  subject: InternalChannelIngressSubject,
): NormalizedIngressSubject {
  return {
    identifiers: subject.identifiers.map((identifier) => ({
      ...identifier,
      authentication: identifierAuthenticationFrom(identifier),
    })),
  };
}

function redactedEntries(entries: readonly NormalizedIngressEntry[]) {
  return entries.map(({ value: _value, identityFieldKey: _identityFieldKey, ...entry }) => entry);
}

function emptyMatch(): RedactedIngressMatch {
  return { matched: false, matchedEntryIds: [] };
}

function mergeMatches(matches: readonly RedactedIngressMatch[]): RedactedIngressMatch {
  const matchedEntryIds = uniqueStrings(matches.flatMap((match) => match.matchedEntryIds));
  const matchedPairs = matches.flatMap((match) => match.matchedPairs ?? []);
  const seenPairs = new Set<string>();
  const uniquePairs = matchedPairs.filter((pair) => {
    const key = JSON.stringify([
      pair.opaqueEntryId,
      pair.opaqueSubjectId,
      pair.subjectAuthentication,
    ]);
    if (seenPairs.has(key)) {
      return false;
    }
    seenPairs.add(key);
    return true;
  });
  return {
    matched: matches.some((match) => match.matched) || matchedEntryIds.length > 0,
    matchedEntryIds,
    ...(uniquePairs.length > 0 ? { matchedPairs: uniquePairs } : {}),
  };
}

function mergeDiagnostics(
  ...groups: Array<readonly RedactedIngressEntryDiagnostic[] | undefined>
): RedactedIngressEntryDiagnostic[] {
  const diagnostics: RedactedIngressEntryDiagnostic[] = [];
  for (const group of groups) {
    if (group) {
      diagnostics.push(...group);
    }
  }
  return diagnostics;
}

function accessGroupFactByName(
  facts: readonly AccessGroupMembershipFact[] | undefined,
): Map<string, AccessGroupMembershipFact> {
  return new Map((facts ?? []).map((fact) => [fact.groupName, fact] as const));
}

async function normalizeAndMatch(params: {
  adapter: InternalChannelIngressAdapter;
  subject: NormalizedIngressSubject;
  accountId: string;
  entries: readonly string[];
  context: "dm" | "group" | "route" | "command";
}): Promise<{
  normalizedEntries: ReturnType<typeof redactedEntries>;
  invalidEntries: RedactedIngressEntryDiagnostic[];
  disabledEntries: RedactedIngressEntryDiagnostic[];
  match: RedactedIngressMatch;
}> {
  if (params.entries.length === 0) {
    return {
      normalizedEntries: [],
      invalidEntries: [],
      disabledEntries: [],
      match: emptyMatch(),
    };
  }
  const normalized = await params.adapter.normalizeEntries({
    entries: params.entries,
    context: params.context,
    accountId: params.accountId,
  });
  const matchable = normalized.matchable.map((entry) => ({
    ...entry,
    authentication: identifierAuthenticationFrom(entry),
  }));
  const match =
    matchable.length > 0
      ? await params.adapter.matchSubject({
          subject: params.subject,
          entries: matchable,
          context: params.context,
        })
      : emptyMatch();
  return {
    normalizedEntries: redactedEntries(matchable),
    invalidEntries: normalized.invalid,
    disabledEntries: normalized.disabled,
    match,
  };
}

function referencedAccessGroups(entries: readonly string[]): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => parseAccessGroupAllowFromEntry(entry))
        .filter((entry): entry is string => entry != null),
    ),
  );
}

function directAllowlistEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null);
}

function groupSenderEntries(params: { groupName: string; input: NormalizedStateInput }): string[] {
  const group = params.input.accessGroups?.[params.groupName];
  if (!group || group.type !== "message.senders") {
    return [];
  }
  return normalizeStringEntries([
    ...(group.members["*"] ?? []),
    ...(group.members[params.input.channelId] ?? []),
  ]);
}

function eventSubjectMatchContext(input: NormalizedStateInput): "dm" | "group" {
  return input.conversation.kind === "direct" ? "dm" : "group";
}

async function normalizeSubjectIdentifiersForMatch(params: {
  input: NormalizedStateInput;
  subject: NormalizedIngressSubject;
  context: "dm" | "group";
  opaquePrefix: string;
}): Promise<NormalizedIngressEntry[]> {
  const normalized = await Promise.all(
    params.subject.identifiers.map(async (identifier, identifierIndex) => {
      const entries = await params.input.adapter.normalizeEntries({
        entries: [identifier.value],
        context: params.context,
        accountId: params.input.accountId,
      });
      return (
        entries.matchable
          // Origin subjects are identity material, not configured allowlists.
          // Do not let a subject value normalize into adapter wildcard semantics.
          .filter(
            (entry) =>
              entry.kind === identifier.kind &&
              (entry.identityFieldKey === undefined ||
                entry.identityFieldKey === identifier.opaqueId) &&
              entry.value !== "*",
          )
          .map((entry, entryIndex) => ({
            opaqueEntryId: `${params.opaquePrefix}-${identifierIndex + 1}:${entryIndex + 1}`,
            kind: entry.kind,
            value: entry.value,
            identityFieldKey: entry.identityFieldKey,
            authentication: identifier.authentication,
            dangerous: entry.dangerous,
            sensitivity: entry.sensitivity,
          }))
      );
    }),
  );
  return normalized.flat();
}

function strongerAuthentication(
  left: IdentifierAuthentication | undefined,
  right: IdentifierAuthentication,
): IdentifierAuthentication {
  if (!left) {
    return right;
  }
  return weakestIdentifierAuthentication(left, right) === left ? right : left;
}

function matchedAuthentication(params: {
  entries: readonly NormalizedIngressEntry[];
  match: RedactedIngressMatch;
}): IdentifierAuthentication | undefined {
  const entries = new Map(params.entries.map((entry) => [entry.opaqueEntryId, entry] as const));
  let strongest: IdentifierAuthentication | undefined;
  for (const pair of params.match.matchedPairs ?? []) {
    const entry = entries.get(pair.opaqueEntryId);
    if (!entry) {
      continue;
    }
    const strength = weakestIdentifierAuthentication(
      entry.authentication,
      pair.subjectAuthentication,
    );
    strongest = strongerAuthentication(strongest, strength);
  }
  if (!strongest) {
    // Legacy adapters return only matched entry ids. Preserve their asserted/static behavior,
    // but do not assign a per-message claim without an exact subject edge.
    for (const entryId of params.match.matchedEntryIds) {
      const entry = entries.get(entryId);
      if (entry) {
        strongest = strongerAuthentication(strongest, entry.authentication);
      }
    }
  }
  return strongest;
}

async function originSubjectAuthentication(
  input: NormalizedStateInput,
): Promise<IdentifierAuthentication | undefined> {
  const origin = input.event.originSubject;
  if (!origin) {
    return undefined;
  }
  let strongest: IdentifierAuthentication | undefined;
  for (const originIdentifier of origin.identifiers) {
    for (const current of input.subject.identifiers) {
      if (
        current.opaqueId !== originIdentifier.opaqueId ||
        current.kind !== originIdentifier.kind ||
        current.value !== originIdentifier.value
      ) {
        continue;
      }
      strongest = strongerAuthentication(
        strongest,
        weakestIdentifierAuthentication(originIdentifier.authentication, current.authentication),
      );
    }
  }

  const context = eventSubjectMatchContext(input);
  const originEntries = await normalizeSubjectIdentifiersForMatch({
    input,
    subject: origin,
    context,
    opaquePrefix: "origin",
  });
  if (originEntries.length > 0) {
    const currentMatch = await input.adapter.matchSubject({
      subject: input.subject,
      entries: originEntries,
      context,
    });
    if (currentMatch.matched) {
      const authentication = matchedAuthentication({ entries: originEntries, match: currentMatch });
      if (authentication) {
        strongest = strongerAuthentication(strongest, authentication);
      }
    }
  }

  const currentEntries = await normalizeSubjectIdentifiersForMatch({
    input,
    subject: input.subject,
    context,
    opaquePrefix: "current",
  });
  if (currentEntries.length > 0) {
    const originMatch = await input.adapter.matchSubject({
      subject: origin,
      entries: currentEntries,
      context,
    });
    const authentication = matchedAuthentication({ entries: currentEntries, match: originMatch });
    if (authentication) {
      strongest = strongerAuthentication(strongest, authentication);
    }
  }
  return strongest;
}

async function resolveAccessGroupEntries(params: {
  input: NormalizedStateInput;
  context: "dm" | "group" | "route" | "command";
  referenced: readonly string[];
}): Promise<{
  normalizedEntries: ReturnType<typeof redactedEntries>;
  invalidEntries: RedactedIngressEntryDiagnostic[];
  disabledEntries: RedactedIngressEntryDiagnostic[];
  matches: RedactedIngressMatch[];
  accessGroups: NormalizedIngressAllowlist["accessGroups"];
}> {
  const factByName = accessGroupFactByName(params.input.accessGroupMembership);
  const accessGroups: NormalizedIngressAllowlist["accessGroups"] = {
    referenced: [...params.referenced],
    matched: [],
    missing: [],
    unsupported: [],
    failed: [],
  };
  const normalizedEntries: ReturnType<typeof redactedEntries> = [];
  const invalidEntries: RedactedIngressEntryDiagnostic[] = [];
  const disabledEntries: RedactedIngressEntryDiagnostic[] = [];
  const matches: RedactedIngressMatch[] = [];

  for (const groupName of params.referenced) {
    const fact = factByName.get(groupName);
    if (fact?.kind === "matched") {
      accessGroups.matched.push(groupName);
      for (const opaqueEntryId of fact.matchedEntryIds) {
        // Dynamic membership proves the group predicate, not a stronger sender identifier.
        // Model it as asserted so raised authentication thresholds fail closed.
        normalizedEntries.push({
          opaqueEntryId,
          kind: "plugin:access-group-membership",
          authentication: "asserted",
        });
      }
      matches.push({ matched: true, matchedEntryIds: fact.matchedEntryIds });
      continue;
    }
    if (fact?.kind === "missing" || fact?.kind === "unsupported" || fact?.kind === "failed") {
      accessGroups[fact.kind].push(groupName);
      continue;
    }
    if (fact?.kind === "not-matched") {
      continue;
    }

    const group = params.input.accessGroups?.[groupName];
    if (!group) {
      accessGroups.missing.push(groupName);
      continue;
    }
    if (group.type !== "message.senders") {
      accessGroups.unsupported.push(groupName);
      continue;
    }

    const groupEntries = groupSenderEntries({ groupName, input: params.input });
    const resolved = await normalizeAndMatch({
      adapter: params.input.adapter,
      subject: params.input.subject,
      accountId: params.input.accountId,
      entries: groupEntries,
      context: params.context,
    });
    normalizedEntries.push(...resolved.normalizedEntries);
    invalidEntries.push(...resolved.invalidEntries);
    disabledEntries.push(...resolved.disabledEntries);
    if (resolved.match.matched) {
      accessGroups.matched.push(groupName);
      matches.push(resolved.match);
    }
  }

  return {
    normalizedEntries,
    invalidEntries,
    disabledEntries,
    matches,
    accessGroups,
  };
}

async function resolveIngressAllowlist(params: {
  input: NormalizedStateInput;
  rawEntries: Array<string | number> | undefined;
  context: "dm" | "group" | "route" | "command";
}): Promise<NormalizedIngressAllowlist> {
  const entries = normalizeStringEntries(params.rawEntries ?? []);
  const referenced = referencedAccessGroups(entries);
  const directEntries = directAllowlistEntries(entries);
  const direct = await normalizeAndMatch({
    adapter: params.input.adapter,
    subject: params.input.subject,
    accountId: params.input.accountId,
    entries: directEntries,
    context: params.context,
  });
  const groups = await resolveAccessGroupEntries({
    input: params.input,
    context: params.context,
    referenced,
  });
  const match = mergeMatches([direct.match, ...groups.matches]);
  return {
    rawEntryCount: entries.length,
    normalizedEntries: [...direct.normalizedEntries, ...groups.normalizedEntries],
    invalidEntries: mergeDiagnostics(direct.invalidEntries, groups.invalidEntries),
    disabledEntries: mergeDiagnostics(direct.disabledEntries, groups.disabledEntries),
    matchedEntryIds: match.matchedEntryIds,
    hasConfiguredEntries: entries.length > 0,
    hasMatchableEntries: direct.normalizedEntries.length > 0 || groups.normalizedEntries.length > 0,
    hasWildcard: directEntries.includes("*"),
    accessGroups: groups.accessGroups,
    match,
  };
}

async function resolveRouteFacts(
  input: NormalizedStateInput,
): Promise<NormalizedIngressState["routeFacts"]> {
  const routeFacts = [...(input.routeFacts ?? [])].toSorted(
    (left, right) => left.precedence - right.precedence || left.id.localeCompare(right.id),
  );
  const resolved: NormalizedIngressState["routeFacts"] = [];
  for (const route of routeFacts) {
    const senderAllowFrom =
      route.senderAllowFrom ??
      (route.senderAllowFromSource === "effective-dm"
        ? input.allowlists.dm
        : route.senderAllowFromSource === "effective-group"
          ? input.allowlists.group
          : undefined);
    resolved.push({
      id: route.id,
      kind: route.kind,
      gate: route.gate,
      effect: route.effect,
      precedence: route.precedence,
      senderPolicy: route.senderPolicy,
      match: route.match,
      senderAllowlist:
        senderAllowFrom != null
          ? await resolveIngressAllowlist({
              input,
              rawEntries: senderAllowFrom,
              context: "route",
            })
          : undefined,
    });
  }
  return resolved;
}

export async function resolveChannelIngressState(
  rawInput: ChannelIngressStateInput,
): Promise<NormalizedIngressState> {
  const input: NormalizedStateInput = {
    ...rawInput,
    subject: normalizeSubjectAuthentication(rawInput.subject),
    event: {
      ...rawInput.event,
      originSubject: rawInput.event.originSubject
        ? normalizeSubjectAuthentication(rawInput.event.originSubject)
        : undefined,
    },
  };
  const [dm, pairingStore, group, commandOwner, commandGroup, routeFacts, eventOriginMatched] =
    await Promise.all([
      resolveIngressAllowlist({ input, rawEntries: input.allowlists.dm, context: "dm" }),
      resolveIngressAllowlist({
        input,
        rawEntries: input.allowlists.pairingStore,
        context: "dm",
      }),
      resolveIngressAllowlist({ input, rawEntries: input.allowlists.group, context: "group" }),
      resolveIngressAllowlist({
        input,
        rawEntries: input.allowlists.commandOwner,
        context: "command",
      }),
      resolveIngressAllowlist({
        input,
        rawEntries: input.allowlists.commandGroup,
        context: "command",
      }),
      resolveRouteFacts(input),
      originSubjectAuthentication(input),
    ]);
  return {
    channelId: input.channelId,
    accountId: input.accountId,
    conversationKind: input.conversation.kind,
    event: {
      kind: input.event.kind,
      authMode: input.event.authMode,
      mayPair: input.event.mayPair,
      hasOriginSubject: input.event.originSubject != null,
      originSubjectMatched: eventOriginMatched !== undefined,
      ...(eventOriginMatched ? { originSubjectAuthentication: eventOriginMatched } : {}),
    },
    mentionFacts: input.mentionFacts,
    routeFacts,
    allowlists: {
      dm,
      pairingStore,
      group,
      commandOwner,
      commandGroup,
    },
  };
}
