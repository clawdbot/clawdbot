import { readChannelAllowFromStore } from "../../pairing/pairing-store.js";
import type { PairingChannel } from "../../pairing/pairing-store.types.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { mergeDmAllowFromSources, resolveGroupAllowFromSources } from "../allow-from.js";
import { decideChannelIngress } from "./decision.js";
import {
  allReferencedAccessGroupNames,
  normalizeEffectiveEntries,
  resolveRuntimeAccessGroupMembershipFacts,
} from "./runtime-access-groups.js";
import {
  createIdentityAdapter,
  createIdentitySubject,
  defineStableChannelIngressIdentity,
} from "./runtime-identity.js";
import type {
  ChannelMessageIngressCommandInput,
  ChannelIngressCommandPresetInput,
  ChannelIngressEventPresetInput,
  ChannelIngressActivationAccess,
  ChannelIngressCommandAccess,
  ChannelIngressRouteAccess,
  ChannelIngressRouteDescriptor,
  ChannelIngressResolver,
  ChannelIngressResolverMessageParams,
  ChannelIngressSenderAccess,
  CreateChannelIngressResolverParams,
  ResolveChannelMessageIngressParams,
  ResolveStableChannelMessageIngressParams,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";
import { resolveChannelIngressState } from "./state.js";
import type {
  AccessGraphGate,
  ChannelIngressChannelId,
  ChannelIngressEventInput,
  ChannelIngressPolicyInput,
  ChannelIngressStateInput,
  RedactedIngressMatch,
  ResolvedIngressAllowlist,
  RouteGateFacts,
  RouteSenderPolicy,
} from "./types.js";

type RouteFactDefaults = {
  id: string;
  kind?: RouteGateFacts["kind"];
  precedence?: number;
  senderPolicy?: RouteSenderPolicy;
  senderAllowFrom?: Array<string | number>;
  senderAllowFromSource?: RouteGateFacts["senderAllowFromSource"];
  match?: RedactedIngressMatch;
};

function shouldReadStore(params: {
  conversationKind: ChannelIngressStateInput["conversation"]["kind"];
  dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
}): boolean {
  return (
    params.conversationKind === "direct" &&
    params.dmPolicy !== "allowlist" &&
    params.dmPolicy !== "open"
  );
}

/**
 * Merge configured direct, group, and pairing-store allowlists into the
 * effective lists consumed by sender and context-visibility checks.
 */
export function resolveChannelIngressEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : undefined;
  const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : undefined;
  const storeAllowFrom = Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : undefined;
  const effectiveAllowFrom = normalizeStringEntries(
    mergeDmAllowFromSources({
      allowFrom,
      storeAllowFrom,
      dmPolicy: params.dmPolicy ?? undefined,
    }),
  );
  const effectiveGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom,
      groupAllowFrom,
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
    }),
  );
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

/**
 * Read pairing-store allowlist entries when a direct-message policy permits
 * store fallback.
 */
export async function readChannelIngressStoreAllowFromForDmPolicy(params: {
  provider: PairingChannel;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: PairingChannel, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  if (
    params.shouldRead === false ||
    params.dmPolicy === "allowlist" ||
    params.dmPolicy === "open"
  ) {
    return [];
  }
  const readStore =
    params.readStore ??
    ((provider: PairingChannel, accountId: string) =>
      readChannelAllowFromStore(provider, process.env, accountId));
  return await readStore(params.provider, params.accountId).catch(() => []);
}

async function readStoreAllowFrom(
  params: ResolveChannelMessageIngressParams & { channelId: ChannelIngressChannelId },
): Promise<Array<string | number>> {
  if (
    !shouldReadStore({
      conversationKind: params.conversation.kind,
      dmPolicy: params.policy.dmPolicy,
    })
  ) {
    return [];
  }
  const entries = params.readStoreAllowFrom
    ? await params
        .readStoreAllowFrom({
          channelId: params.channelId,
          accountId: params.accountId,
          dmPolicy: params.policy.dmPolicy,
        })
        .catch(() => [])
    : params.useDefaultPairingStore
      ? await readChannelIngressStoreAllowFromForDmPolicy({
          provider: params.channelId as PairingChannel,
          accountId: params.accountId,
          dmPolicy: params.policy.dmPolicy,
        })
      : [];
  return [...(entries ?? [])];
}

function commandRequested(policy: ChannelIngressPolicyInput): boolean {
  return policy.command != null;
}

function normalizeChannelId(id: string): ChannelIngressChannelId {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Channel ingress channel id must be non-empty.");
  }
  return trimmed;
}

function findIngressGate(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  phase: AccessGraphGate["phase"];
  kind: AccessGraphGate["kind"];
}): AccessGraphGate | undefined {
  return params.ingress.graph.gates.find(
    (gate) => gate.phase === params.phase && gate.kind === params.kind,
  );
}

function findSenderGate(
  ingress: ResolvedChannelMessageIngress["ingress"],
  isGroup: boolean,
): AccessGraphGate | undefined {
  return findIngressGate({
    ingress,
    phase: "sender",
    kind: isGroup ? "groupSender" : "dmSender",
  });
}

function useAccessGroupsFromConfig(params: {
  useAccessGroups?: boolean | null;
  cfg?: ChannelIngressCommandPresetInput["cfg"];
}): boolean {
  return params.useAccessGroups ?? params.cfg?.commands?.useAccessGroups !== false;
}

function channelIngressCommand(
  params: ChannelIngressCommandPresetInput = {},
): ChannelMessageIngressCommandInput | undefined {
  if (params.requested === false) {
    return undefined;
  }
  const { requested: _requested, cfg, ...command } = params;
  return {
    ...command,
    useAccessGroups: useAccessGroupsFromConfig({
      useAccessGroups: params.useAccessGroups,
      cfg,
    }),
    allowTextCommands: params.allowTextCommands ?? false,
    hasControlCommand: params.hasControlCommand ?? true,
  };
}

function channelIngressEvent(
  params: ChannelIngressEventPresetInput = {},
): ChannelIngressEventInput {
  const isGroup = params.isGroup ?? false;
  return {
    kind: params.kind ?? "message",
    authMode: params.authMode ?? "inbound",
    mayPair: params.mayPair ?? !isGroup,
    ...(params.originSubject ? { originSubject: params.originSubject } : {}),
  };
}

function resolveCommandInput(params: {
  command?: ChannelIngressResolverMessageParams["command"];
  useAccessGroups?: boolean | null;
}): ChannelMessageIngressCommandInput | undefined {
  if (params.command === false || params.command == null) {
    return undefined;
  }
  return channelIngressCommand({
    ...params.command,
    useAccessGroups: params.command.useAccessGroups ?? params.useAccessGroups,
  });
}

function resolveResolverPolicy(params: {
  base: CreateChannelIngressResolverParams;
  input: ChannelIngressResolverMessageParams;
}): ChannelIngressPolicyInput {
  return {
    dmPolicy: params.input.dmPolicy ?? params.base.defaultDmPolicy ?? "pairing",
    groupPolicy: params.input.groupPolicy ?? params.base.defaultGroupPolicy ?? "disabled",
    groupAllowFromFallbackToAllowFrom:
      params.input.policy?.groupAllowFromFallbackToAllowFrom ??
      params.base.groupAllowFromFallbackToAllowFrom,
    mutableIdentifierMatching:
      params.input.policy?.mutableIdentifierMatching ?? params.base.mutableIdentifierMatching,
    ...(params.input.policy?.activation ? { activation: params.input.policy.activation } : {}),
  };
}

/**
 * Create a reusable ingress resolver for one channel account and identity
 * descriptor.
 */
export function createChannelIngressResolver(
  base: CreateChannelIngressResolverParams,
): ChannelIngressResolver {
  const resolve = async (
    input: ChannelIngressResolverMessageParams,
    eventDefaults?: ChannelIngressEventPresetInput,
  ) => {
    const isGroup = input.conversation.kind !== "direct";
    const useAccessGroups = useAccessGroupsFromConfig({
      useAccessGroups: base.useAccessGroups,
      cfg: base.cfg,
    });
    return await resolveChannelMessageIngress({
      channelId: base.channelId,
      accountId: base.accountId,
      identity: base.identity,
      subject: input.subject,
      conversation: input.conversation,
      event: channelIngressEvent({
        isGroup,
        ...eventDefaults,
        ...input.event,
      }),
      policy: resolveResolverPolicy({ base, input }),
      allowFrom: input.allowFrom,
      groupAllowFrom: input.groupAllowFrom,
      route: input.route,
      routeFacts: input.routeFacts,
      accessGroups: base.accessGroups ?? base.cfg?.accessGroups,
      accessGroupMembership: [
        ...(base.accessGroupMembership ?? []),
        ...(input.accessGroupMembership ?? []),
      ],
      resolveAccessGroupMembership: base.resolveAccessGroupMembership,
      accessGroupMatchedAllowFromEntry: base.accessGroupMatchedAllowFromEntry,
      providerMissingFallbackApplied: input.providerMissingFallbackApplied,
      mentionFacts: input.mentionFacts,
      readStoreAllowFrom: base.readStoreAllowFrom,
      useDefaultPairingStore: base.useDefaultPairingStore,
      command: resolveCommandInput({
        command: input.command,
        useAccessGroups,
      }),
    });
  };
  return {
    message: async (input) => await resolve(input),
    command: async (input) =>
      await resolve(input, {
        authMode: "command",
        mayPair: false,
      }),
    event: async (input) => await resolve(input, { mayPair: false }),
  };
}

/**
 * Resolve one inbound event using a simple stable subject identity descriptor.
 */
export async function resolveStableChannelMessageIngress(
  params: ResolveStableChannelMessageIngressParams,
): Promise<ResolvedChannelMessageIngress> {
  return await createChannelIngressResolver({
    ...params,
    identity: defineStableChannelIngressIdentity(params.identity),
  }).message(params);
}

function routeDescriptors(
  route: ResolveChannelMessageIngressParams["route"],
): ChannelIngressRouteDescriptor[] {
  if (!route) {
    return [];
  }
  if (Array.isArray(route)) {
    return [...route];
  }
  return [route as ChannelIngressRouteDescriptor];
}

/**
 * Collect optional route descriptors while dropping false, null, and undefined
 * entries.
 */
export function channelIngressRoutes(
  ...routes: Array<ChannelIngressRouteDescriptor | false | null | undefined>
): ChannelIngressRouteDescriptor[] {
  return routes.filter((route): route is ChannelIngressRouteDescriptor => Boolean(route));
}

function routeDescriptorMatch(descriptor: ChannelIngressRouteDescriptor) {
  const matched = descriptor.matched ?? descriptor.allowed ?? descriptor.enabled !== false;
  return {
    matched,
    matchedEntryIds: matched && descriptor.matchId ? [descriptor.matchId] : [],
  };
}

function routeFact(
  params: RouteFactDefaults & Pick<RouteGateFacts, "gate" | "effect">,
): RouteGateFacts {
  return {
    id: params.id,
    kind: params.kind ?? "route",
    gate: params.gate,
    effect: params.effect,
    precedence: params.precedence ?? 0,
    senderPolicy: params.senderPolicy ?? "inherit",
    senderAllowFrom: params.senderAllowFrom,
    senderAllowFromSource: params.senderAllowFromSource,
    match: params.match,
  };
}

function routeFactDefaults(descriptor: ChannelIngressRouteDescriptor) {
  return {
    id: descriptor.id,
    ...(descriptor.kind ? { kind: descriptor.kind } : {}),
    ...(descriptor.precedence !== undefined ? { precedence: descriptor.precedence } : {}),
    ...(descriptor.senderPolicy ? { senderPolicy: descriptor.senderPolicy } : {}),
    ...(descriptor.senderAllowFrom != null
      ? { senderAllowFrom: [...descriptor.senderAllowFrom] }
      : {}),
    ...(descriptor.senderAllowFromSource
      ? { senderAllowFromSource: descriptor.senderAllowFromSource }
      : {}),
    match: routeDescriptorMatch(descriptor),
  };
}

function routeFactsFromDescriptors(
  route: ResolveChannelMessageIngressParams["route"],
): RouteGateFacts[] {
  return routeDescriptors(route).flatMap((descriptor) => {
    if (descriptor.configured === false) {
      return [];
    }
    const defaults = routeFactDefaults(descriptor);
    if (descriptor.enabled === false) {
      return [routeFact({ ...defaults, gate: "disabled", effect: "block-dispatch" })];
    }
    if (descriptor.allowed !== undefined) {
      return [
        routeFact({
          ...defaults,
          gate: descriptor.allowed ? "matched" : "not-matched",
          effect: descriptor.allowed ? "allow" : "block-dispatch",
        }),
      ];
    }
    if (
      descriptor.senderPolicy !== "deny-when-empty" &&
      descriptor.senderAllowFrom == null &&
      descriptor.senderAllowFromSource == null
    ) {
      return [];
    }
    return [
      routeFact({
        ...defaults,
        kind: descriptor.senderPolicy === "deny-when-empty" ? defaults.kind : "routeSender",
        gate: "matched",
        effect: "allow",
        senderPolicy:
          descriptor.senderPolicy === "deny-when-empty" ? "deny-when-empty" : defaults.senderPolicy,
      }),
    ];
  });
}

function routeDescriptorForGate(params: {
  descriptors: readonly ChannelIngressRouteDescriptor[];
  gate: AccessGraphGate;
}): ChannelIngressRouteDescriptor | undefined {
  const senderSuffix = ":sender";
  const baseGateId = params.gate.id.endsWith(senderSuffix)
    ? params.gate.id.slice(0, -senderSuffix.length)
    : params.gate.id;
  return params.descriptors.find(
    (descriptor) => descriptor.id === params.gate.id || descriptor.id === baseGateId,
  );
}

function projectRouteAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  route: ResolveChannelMessageIngressParams["route"];
}): ChannelIngressRouteAccess {
  const descriptors = routeDescriptors(params.route);
  const routeBlock = params.ingress.graph.gates.find(
    (entry) => entry.phase === "route" && entry.effect === "block-dispatch",
  );
  if (routeBlock) {
    const descriptor = routeDescriptorForGate({ descriptors, gate: routeBlock });
    return {
      allowed: routeBlock.allowed,
      reasonCode: routeBlock.reasonCode,
      ...(descriptor?.blockReason ? { reason: descriptor.blockReason } : {}),
      gate: routeBlock,
    };
  }
  const routeSenderReplacement = descriptors.find(
    (descriptor) => descriptor.senderPolicy === "replace" && descriptor.blockReason,
  );
  const senderBlock = params.ingress.graph.gates.find(
    (entry) => entry.phase === "sender" && entry.effect === "block-dispatch",
  );
  if (routeSenderReplacement && senderBlock) {
    return {
      allowed: false,
      reasonCode: senderBlock.reasonCode,
      reason: routeSenderReplacement.blockReason,
      gate: senderBlock,
    };
  }
  const gate = params.ingress.graph.gates.find((entry) => entry.phase === "route");
  if (gate) {
    return {
      allowed: gate.allowed,
      reasonCode: gate.reasonCode,
      gate,
    };
  }
  return { allowed: true };
}

function projectSenderAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  isGroup: boolean;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  providerMissingFallbackApplied?: boolean;
}): ChannelIngressSenderAccess {
  const gate = findSenderGate(params.ingress, params.isGroup);
  const reasonCode =
    !gate &&
    params.isGroup &&
    params.ingress.reasonCode === "route_sender_empty" &&
    params.effectiveGroupAllowFrom.length === 0
      ? "group_policy_empty_allowlist"
      : (gate?.reasonCode ?? params.ingress.reasonCode);
  const decision =
    reasonCode === "dm_policy_pairing_required"
      ? "pairing"
      : gate?.allowed === true
        ? "allow"
        : "block";
  return {
    allowed: decision === "allow",
    decision,
    reasonCode,
    ...(gate ? { gate } : {}),
    effectiveAllowFrom: params.effectiveAllowFrom,
    effectiveGroupAllowFrom: params.effectiveGroupAllowFrom,
    providerMissingFallbackApplied: params.providerMissingFallbackApplied ?? false,
  };
}

function projectCommandAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  policy: ChannelIngressPolicyInput;
}): ChannelIngressCommandAccess {
  const gate = findIngressGate({
    ingress: params.ingress,
    phase: "command",
    kind: "command",
  });
  return {
    requested: commandRequested(params.policy),
    authorized: commandRequested(params.policy) ? gate?.allowed === true : false,
    shouldBlockControlCommand: gate?.command?.shouldBlockControlCommand === true,
    reasonCode: gate?.reasonCode ?? params.ingress.reasonCode,
    ...(gate ? { gate } : {}),
  };
}

function projectActivationAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
}): ChannelIngressActivationAccess {
  const gate = findIngressGate({
    ingress: params.ingress,
    phase: "activation",
    kind: "mention",
  });
  return {
    ran: gate != null,
    allowed: gate?.allowed === true,
    shouldSkip: gate?.activation?.shouldSkip === true,
    reasonCode: gate?.reasonCode ?? params.ingress.reasonCode,
    ...(gate?.activation?.effectiveWasMentioned !== undefined
      ? { effectiveWasMentioned: gate.activation.effectiveWasMentioned }
      : {}),
    ...(gate?.activation?.shouldBypassMention !== undefined
      ? { shouldBypassMention: gate.activation.shouldBypassMention }
      : {}),
    ...(gate ? { gate } : {}),
  };
}

function commandOwnerAllowFrom(params: {
  command?: ChannelMessageIngressCommandInput;
  isGroup: boolean;
  configuredAllowFrom: Array<string | number>;
  effectiveAllowFrom: string[];
}): Array<string | number> {
  if (params.command?.commandOwnerAllowFrom != null) {
    return params.command.commandOwnerAllowFrom;
  }
  if (!params.isGroup) {
    return params.effectiveAllowFrom;
  }
  return params.command?.groupOwnerAllowFrom === "none" ? [] : params.configuredAllowFrom;
}

function commandGroupAllowFrom(params: {
  command?: ChannelMessageIngressCommandInput;
  isGroup: boolean;
  effectiveCommandGroupAllowFrom: string[];
}): Array<string | number> {
  if (params.isGroup) {
    return params.effectiveCommandGroupAllowFrom;
  }
  return params.command?.directGroupAllowFrom === "effective"
    ? params.effectiveCommandGroupAllowFrom
    : [];
}

function accessGroupMatchedEntry(params: ResolveChannelMessageIngressParams): string | null {
  const entry = params.accessGroupMatchedAllowFromEntry ?? params.subject.stableId;
  return entry == null ? null : String(entry);
}

function appendAccessGroupMatchedEntry(params: {
  entries: string[];
  allowlist: ResolvedIngressAllowlist;
  matchedEntry: string | null;
}): string[] {
  return params.matchedEntry && params.allowlist.accessGroups.matched.length > 0
    ? Array.from(new Set([...params.entries, params.matchedEntry]))
    : params.entries;
}

/**
 * Resolve sender, route, command, event, and activation gates for one inbound
 * channel event.
 */
export async function resolveChannelMessageIngress(
  params: ResolveChannelMessageIngressParams,
): Promise<ResolvedChannelMessageIngress> {
  const channelId = normalizeChannelId(params.channelId);
  const adapter = createIdentityAdapter(params.identity);
  const subject = createIdentitySubject(params.identity, params.subject);
  const routeFacts = [...routeFactsFromDescriptors(params.route), ...(params.routeFacts ?? [])];
  const storeAllowFrom = await readStoreAllowFrom({ ...params, channelId });
  const rawAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
  const rawStoreAllowFrom = normalizeStringEntries(storeAllowFrom);
  const rawGroupAllowFrom = normalizeStringEntries(params.groupAllowFrom ?? []);
  const normalizeEffective = (entries: readonly (string | number)[], context: "dm" | "group") =>
    normalizeEffectiveEntries({ adapter, accountId: params.accountId, entries, context });
  const [normalizedAllowFrom, normalizedStoreAllowFrom, normalizedGroupAllowFrom] =
    await Promise.all([
      normalizeEffective(rawAllowFrom, "dm"),
      normalizeEffective(rawStoreAllowFrom, "dm"),
      normalizeEffective(rawGroupAllowFrom, "group"),
    ]);
  const referencedAccessGroups = allReferencedAccessGroupNames([
    rawAllowFrom,
    rawGroupAllowFrom,
    rawStoreAllowFrom,
    params.command?.commandOwnerAllowFrom ?? [],
    ...routeFacts.map((route) => route.senderAllowFrom ?? []),
  ]);
  const runtimeAccessGroupMembership = await resolveRuntimeAccessGroupMembershipFacts({
    input: params,
    channelId,
    names: referencedAccessGroups,
  });
  const accessGroupMembership = [
    ...runtimeAccessGroupMembership,
    ...(params.accessGroupMembership ?? []),
  ];
  const baseEffective = resolveChannelIngressEffectiveAllowFromLists({
    allowFrom: normalizedAllowFrom,
    groupAllowFrom: normalizedGroupAllowFrom,
    storeAllowFrom: normalizedStoreAllowFrom,
    dmPolicy: params.policy.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.policy.groupAllowFromFallbackToAllowFrom,
  });
  const rawEffective = resolveChannelIngressEffectiveAllowFromLists({
    allowFrom: rawAllowFrom,
    groupAllowFrom: rawGroupAllowFrom,
    storeAllowFrom: rawStoreAllowFrom,
    dmPolicy: params.policy.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.policy.groupAllowFromFallbackToAllowFrom,
  });
  const rawCommandGroup = resolveChannelIngressEffectiveAllowFromLists({
    allowFrom: rawAllowFrom,
    groupAllowFrom: rawGroupAllowFrom,
    dmPolicy: params.policy.dmPolicy,
    groupAllowFromFallbackToAllowFrom:
      params.command?.commandGroupAllowFromFallbackToAllowFrom ??
      params.policy.groupAllowFromFallbackToAllowFrom,
  });
  const isGroup = params.conversation.kind !== "direct";
  const policy: ChannelIngressPolicyInput = {
    ...params.policy,
    ...(params.command !== undefined ? { command: params.command } : {}),
  };
  const state = await resolveChannelIngressState({
    channelId,
    accountId: params.accountId,
    subject,
    conversation: params.conversation,
    adapter,
    accessGroups: params.accessGroups,
    accessGroupMembership,
    routeFacts,
    mentionFacts: params.mentionFacts,
    event: params.event,
    allowlists: {
      dm: rawAllowFrom,
      group: rawEffective.effectiveGroupAllowFrom,
      pairingStore: rawStoreAllowFrom,
      commandOwner: commandOwnerAllowFrom({
        command: params.command,
        isGroup,
        configuredAllowFrom: rawAllowFrom,
        effectiveAllowFrom: rawEffective.effectiveAllowFrom,
      }),
      commandGroup: commandGroupAllowFrom({
        command: params.command,
        isGroup,
        effectiveCommandGroupAllowFrom: rawCommandGroup.effectiveGroupAllowFrom,
      }),
    },
  });
  const ingress = decideChannelIngress(state, policy);
  const matchedAccessGroupEntry = accessGroupMatchedEntry(params);
  const effectiveAllowFrom = appendAccessGroupMatchedEntry({
    entries: baseEffective.effectiveAllowFrom,
    allowlist: state.allowlists.dm,
    matchedEntry: matchedAccessGroupEntry,
  });
  const effectiveGroupAllowFrom = appendAccessGroupMatchedEntry({
    entries: baseEffective.effectiveGroupAllowFrom,
    allowlist: state.allowlists.group,
    matchedEntry: matchedAccessGroupEntry,
  });
  const senderAccess = projectSenderAccess({
    ingress,
    isGroup,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    providerMissingFallbackApplied: params.providerMissingFallbackApplied,
  });
  const routeAccess = projectRouteAccess({ ingress, route: params.route });
  const commandAccess = projectCommandAccess({ ingress, policy });
  const activationAccess = projectActivationAccess({ ingress });
  return {
    state,
    ingress,
    senderAccess,
    routeAccess,
    commandAccess,
    activationAccess,
  };
}
