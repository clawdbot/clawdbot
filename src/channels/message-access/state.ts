import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { parseAccessGroupAllowFromEntry } from "../allow-from.js";
import type {
  AccessGroupMembershipFact,
  ChannelIngressState,
  ChannelIngressStateInput,
  InternalChannelIngressAdapter,
  InternalChannelIngressSubject,
  InternalNormalizedEntry,
  RedactedIngressEntryDiagnostic,
  RedactedIngressMatch,
  ResolvedRouteGateFacts,
  ResolvedIngressAllowlist,
} from "./types.js";

function redactedEntries(entries: readonly InternalNormalizedEntry[]) {
  return entries.map(({ value: _value, ...entry }) => entry);
}

function emptyMatch(): RedactedIngressMatch {
  return { matched: false, matchedEntryIds: [] };
}

function mergeMatches(matches: readonly RedactedIngressMatch[]): RedactedIngressMatch {
  const matchedEntryIds = Array.from(new Set(matches.flatMap((match) => match.matchedEntryIds)));
  return {
    matched: matches.some((match) => match.matched) || matchedEntryIds.length > 0,
    matchedEntryIds,
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
  subject: InternalChannelIngressSubject;
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
  const match =
    normalized.matchable.length > 0
      ? await params.adapter.matchSubject({
          subject: params.subject,
          entries: normalized.matchable,
          context: params.context,
        })
      : emptyMatch();
  return {
    normalizedEntries: redactedEntries(normalized.matchable),
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

function groupSenderEntries(params: {
  groupName: string;
  input: ChannelIngressStateInput;
}): string[] {
  const group = params.input.accessGroups?.[params.groupName];
  if (!group || group.type !== "message.senders") {
    return [];
  }
  return normalizeStringEntries([
    ...(group.members["*"] ?? []),
    ...(group.members[params.input.channelId] ?? []),
  ]);
}

function eventSubjectMatchContext(input: ChannelIngressStateInput): "dm" | "group" {
  return input.conversation.kind === "direct" ? "dm" : "group";
}

async function normalizeSubjectIdentifiersForMatch(params: {
  input: ChannelIngressStateInput;
  subject: InternalChannelIngressSubject;
  context: "dm" | "group";
  opaquePrefix: string;
}): Promise<InternalNormalizedEntry[]> {
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
          .filter((entry) => entry.kind === identifier.kind && entry.value !== "*")
          .map((entry, entryIndex) => ({
            opaqueEntryId: `${params.opaquePrefix}-${identifierIndex + 1}:${entryIndex + 1}`,
            kind: entry.kind,
            value: entry.value,
            dangerous: entry.dangerous,
            sensitivity: entry.sensitivity,
          }))
      );
    }),
  );
  return normalized.flat();
}

async function originSubjectMatched(input: ChannelIngressStateInput): Promise<boolean> {
  const origin = input.event.originSubject;
  if (!origin) {
    return false;
  }
  if (
    origin.identifiers.some((identifier) =>
      input.subject.identifiers.some(
        (current) => current.kind === identifier.kind && current.value === identifier.value,
      ),
    )
  ) {
    return true;
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
      return true;
    }
  }

  const currentEntries = await normalizeSubjectIdentifiersForMatch({
    input,
    subject: input.subject,
    context,
    opaquePrefix: "current",
  });
  if (currentEntries.length === 0) {
    return false;
  }
  const originMatch = await input.adapter.matchSubject({
    subject: origin,
    entries: currentEntries,
    context,
  });
  return originMatch.matched;
}

async function resolveAccessGroupEntries(params: {
  input: ChannelIngressStateInput;
  context: "dm" | "group" | "route" | "command";
  referenced: readonly string[];
}): Promise<{
  normalizedEntries: ReturnType<typeof redactedEntries>;
  invalidEntries: RedactedIngressEntryDiagnostic[];
  disabledEntries: RedactedIngressEntryDiagnostic[];
  matches: RedactedIngressMatch[];
  accessGroups: ResolvedIngressAllowlist["accessGroups"];
}> {
  const factByName = accessGroupFactByName(params.input.accessGroupMembership);
  const accessGroups: ResolvedIngressAllowlist["accessGroups"] = {
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
  input: ChannelIngressStateInput;
  rawEntries: Array<string | number> | undefined;
  context: "dm" | "group" | "route" | "command";
}): Promise<ResolvedIngressAllowlist> {
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
  input: ChannelIngressStateInput,
): Promise<ResolvedRouteGateFacts[]> {
  const routeFacts = [...(input.routeFacts ?? [])].toSorted(
    (left, right) => left.precedence - right.precedence || left.id.localeCompare(right.id),
  );
  const resolved: ResolvedRouteGateFacts[] = [];
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
  input: ChannelIngressStateInput,
): Promise<ChannelIngressState> {
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
      originSubjectMatched(input),
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
      originSubjectMatched: eventOriginMatched,
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
