import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  AgentSelectionRequiredError,
  listAgentEntries,
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope.js";
import type { ChatType } from "../channels/chat-type.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { DmScope, GroupScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldLogVerbose } from "../globals.js";
import { logDebug } from "../logger.js";
import {
  normalizeRouteBindingId,
  normalizeRouteBindingRoles,
  routeBindingScopeMatches,
} from "./binding-scope.js";
import { listBindings } from "./bindings.js";
import { peerKindMatches } from "./peer-kind-match.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAccountId,
  normalizeAgentId,
  sanitizeAgentId,
} from "./session-key.js";

/** @deprecated Use ChatType from channels/chat-type.js */
export type RoutePeerKind = ChatType;

export type RoutePeer = {
  kind: ChatType;
  id: string;
};

export type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  /** Known owner when no configured binding matches this route. */
  defaultAgentId?: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  dmScope?: DmScope;
  groupScope?: GroupScope;
  /** Parent peer for threads — used for binding inheritance when peer doesn't match directly. */
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
  /** Discord member role IDs — used for role-based agent routing. */
  memberRoleIds?: string[];
};

export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  /** Effective direct-message scope after a matching binding override. */
  dmScope?: DmScope;
  groupScope?: GroupScope;
  /** Internal session key used for persistence + concurrency. */
  sessionKey: string;
  /** Convenience alias for direct-chat collapse. */
  mainSessionKey: string;
  /** Which session should receive inbound last-route updates. */
  lastRoutePolicy: "main" | "session";
  /** Match description for debugging/logging. */
  matchedBy:
    | "binding.peer"
    | "binding.peer.parent"
    | "binding.peer.wildcard"
    | "binding.guild+roles"
    | "binding.guild"
    | "binding.team"
    | "binding.account"
    | "binding.channel"
    | "default";
};

export function deriveLastRoutePolicy(params: {
  sessionKey: string;
  mainSessionKey: string;
}): ResolvedAgentRoute["lastRoutePolicy"] {
  return params.sessionKey === params.mainSessionKey ? "main" : "session";
}

export function resolveInboundLastRouteSessionKey(params: {
  route: Pick<ResolvedAgentRoute, "lastRoutePolicy" | "mainSessionKey">;
  sessionKey: string;
}): string {
  return params.route.lastRoutePolicy === "main" ? params.route.mainSessionKey : params.sessionKey;
}

export function buildAgentSessionKey(params: {
  agentId: string;
  mainKey?: string;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  /** DM session scope. */
  dmScope?: DmScope;
  groupScope?: GroupScope;
  identityLinks?: Record<string, string[]>;
}): string {
  const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
  const peer = params.peer;
  return buildAgentPeerSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey ?? DEFAULT_MAIN_KEY,
    channel,
    accountId: params.accountId,
    peerKind: peer?.kind ?? "direct",
    peerId: peer ? normalizeRouteBindingId(peer.id) || "unknown" : null,
    dmScope: params.dmScope,
    groupScope: params.groupScope,
    identityLinks: params.identityLinks,
  });
}

type AgentLookupCache = {
  agentsRef: OpenClawConfig["agents"] | undefined;
  byNormalizedId: Map<string, string>;
  fallbackSoleAgentId?: string;
};

const agentLookupCacheByCfg = new WeakMap<OpenClawConfig, AgentLookupCache>();

function resolveAgentLookupCache(cfg: OpenClawConfig): AgentLookupCache {
  const agentsRef = cfg.agents;
  const existing = agentLookupCacheByCfg.get(cfg);
  if (existing && existing.agentsRef === agentsRef) {
    return existing;
  }

  const byNormalizedId = new Map<string, string>();
  for (const agent of listAgentEntries(cfg)) {
    const rawId = agent.id?.trim();
    if (!rawId) {
      continue;
    }
    byNormalizedId.set(normalizeAgentId(rawId), sanitizeAgentId(rawId));
  }
  const next: AgentLookupCache = {
    agentsRef,
    byNormalizedId,
    fallbackSoleAgentId: tryResolveLegacyCompatibilityAgentId(cfg),
  };
  agentLookupCacheByCfg.set(cfg, next);
  return next;
}

export function pickFirstExistingAgentId(cfg: OpenClawConfig, agentId: string): string {
  const lookup = resolveAgentLookupCache(cfg);
  const trimmed = (agentId ?? "").trim();
  if (!trimmed) {
    return sanitizeAgentId(
      lookup.fallbackSoleAgentId ??
        resolveDefaultAgentId(cfg, {
          surface: "agent lookup",
          hint: "Pass an explicit agent id instead of relying on an implicit route.",
        }),
    );
  }
  const normalized = normalizeAgentId(trimmed);
  const resolved = lookup.byNormalizedId.get(normalized);
  if (resolved) {
    return resolved;
  }
  if (normalized === DEFAULT_AGENT_ID) {
    return DEFAULT_AGENT_ID;
  }
  if (lookup.byNormalizedId.size === 0) {
    return sanitizeAgentId(trimmed);
  }
  throw new AgentSelectionRequiredError([...lookup.byNormalizedId.values()], {
    surface: "route binding",
    hint: `Update the binding agentId "${trimmed}" to a configured agent.`,
  });
}

type NormalizedPeerConstraint =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "wildcard-kind"; kind: ChatType }
  | { state: "valid"; kind: ChatType; id: string };

type NormalizedBindingMatch = {
  accountPattern: string;
  peer: NormalizedPeerConstraint;
  guildId: string | null;
  teamId: string | null;
  roles: string[] | null;
};

type EvaluatedBinding = {
  binding: ReturnType<typeof listBindings>[number];
  match: NormalizedBindingMatch;
  order: number;
};

type BindingScope = {
  peer: RoutePeer | null;
  guildId: string;
  teamId: string;
  memberRoleIds: Set<string>;
};

type EvaluatedBindingsCache = {
  bindingsRef: OpenClawConfig["bindings"];
  byChannel: Map<string, EvaluatedBindingsByChannel>;
  byChannelAccount: Map<string, EvaluatedBinding[]>;
  byChannelAccountIndex: Map<string, EvaluatedBindingsIndex>;
};

const evaluatedBindingsCacheByCfg = new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
const MAX_EVALUATED_BINDINGS_CACHE_KEYS = 2000;
const resolvedRouteCacheByCfg = new WeakMap<
  OpenClawConfig,
  {
    bindingsRef: OpenClawConfig["bindings"];
    agentsRef: OpenClawConfig["agents"];
    sessionRef: OpenClawConfig["session"];
    byKey: Map<string, ResolvedAgentRoute>;
  }
>();
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000;

type EvaluatedBindingsIndex = {
  byPeer: Map<string, EvaluatedBinding[]>;
  byPeerWildcard: EvaluatedBinding[];
  byGuildWithRoles: Map<string, EvaluatedBinding[]>;
  byGuild: Map<string, EvaluatedBinding[]>;
  byTeam: Map<string, EvaluatedBinding[]>;
  byAccount: EvaluatedBinding[];
  byChannel: EvaluatedBinding[];
};

type EvaluatedBindingsByChannel = {
  byAccount: Map<string, EvaluatedBinding[]>;
  byAnyAccount: EvaluatedBinding[];
};

function buildEvaluatedBindingsByChannel(
  cfg: OpenClawConfig,
): Map<string, EvaluatedBindingsByChannel> {
  const byChannel = new Map<string, EvaluatedBindingsByChannel>();
  let order = 0;
  for (const binding of listBindings(cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    const channel = normalizeLowercaseStringOrEmpty(binding.match?.channel);
    if (!channel) {
      continue;
    }
    const match = normalizeBindingMatch(binding.match);
    // Unmatchable peers cannot establish routing or account-ownership evidence.
    if (match.peer.state === "invalid") {
      continue;
    }
    const evaluated: EvaluatedBinding = {
      binding,
      match,
      order,
    };
    order += 1;
    let bucket = byChannel.get(channel);
    if (!bucket) {
      bucket = {
        byAccount: new Map<string, EvaluatedBinding[]>(),
        byAnyAccount: [],
      };
      byChannel.set(channel, bucket);
    }
    if (match.accountPattern === "*") {
      bucket.byAnyAccount.push(evaluated);
      continue;
    }
    const accountKey = normalizeAccountId(match.accountPattern);
    const existing = bucket.byAccount.get(accountKey);
    if (existing) {
      existing.push(evaluated);
      continue;
    }
    bucket.byAccount.set(accountKey, [evaluated]);
  }
  return byChannel;
}

function mergeEvaluatedBindingsInSourceOrder(
  accountScoped: EvaluatedBinding[],
  anyAccount: EvaluatedBinding[],
): EvaluatedBinding[] {
  if (accountScoped.length === 0) {
    return anyAccount;
  }
  if (anyAccount.length === 0) {
    return accountScoped;
  }
  const merged: EvaluatedBinding[] = [];
  let accountIdx = 0;
  let anyIdx = 0;
  while (accountIdx < accountScoped.length && anyIdx < anyAccount.length) {
    const accountBinding = accountScoped[accountIdx];
    const anyBinding = anyAccount[anyIdx];
    if (
      (accountBinding?.order ?? Number.MAX_SAFE_INTEGER) <=
      (anyBinding?.order ?? Number.MAX_SAFE_INTEGER)
    ) {
      if (accountBinding) {
        merged.push(accountBinding);
      }
      accountIdx += 1;
      continue;
    }
    if (anyBinding) {
      merged.push(anyBinding);
    }
    anyIdx += 1;
  }
  if (accountIdx < accountScoped.length) {
    merged.push(...accountScoped.slice(accountIdx));
  }
  if (anyIdx < anyAccount.length) {
    merged.push(...anyAccount.slice(anyIdx));
  }
  return merged;
}

function pushToIndexMap(
  map: Map<string, EvaluatedBinding[]>,
  key: string | null,
  binding: EvaluatedBinding,
): void {
  if (!key) {
    return;
  }
  const existing = map.get(key);
  if (existing) {
    existing.push(binding);
    return;
  }
  map.set(key, [binding]);
}

function peerLookupKeys(kind: ChatType, id: string): string[] {
  if (kind === "group") {
    return [`group:${id}`, `channel:${id}`];
  }
  if (kind === "channel") {
    return [`channel:${id}`, `group:${id}`];
  }
  return [`${kind}:${id}`];
}

function collectPeerIndexedBindings(
  index: EvaluatedBindingsIndex,
  peer: RoutePeer | null,
): EvaluatedBinding[] {
  if (!peer) {
    return [];
  }
  const out: EvaluatedBinding[] = [];
  const seen = new Set<EvaluatedBinding>();
  for (const key of peerLookupKeys(peer.kind, peer.id)) {
    const matches = index.byPeer.get(key);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      if (seen.has(match)) {
        continue;
      }
      seen.add(match);
      out.push(match);
    }
  }
  return out;
}

function buildEvaluatedBindingsIndex(bindings: EvaluatedBinding[]): EvaluatedBindingsIndex {
  const byPeer = new Map<string, EvaluatedBinding[]>();
  const byPeerWildcard: EvaluatedBinding[] = [];
  const byGuildWithRoles = new Map<string, EvaluatedBinding[]>();
  const byGuild = new Map<string, EvaluatedBinding[]>();
  const byTeam = new Map<string, EvaluatedBinding[]>();
  const byAccount: EvaluatedBinding[] = [];
  const byChannel: EvaluatedBinding[] = [];

  for (const binding of bindings) {
    if (binding.match.peer.state === "valid") {
      for (const key of peerLookupKeys(binding.match.peer.kind, binding.match.peer.id)) {
        pushToIndexMap(byPeer, key, binding);
      }
      continue;
    }
    if (binding.match.peer.state === "wildcard-kind") {
      byPeerWildcard.push(binding);
      continue;
    }
    if (binding.match.guildId && binding.match.roles) {
      pushToIndexMap(byGuildWithRoles, binding.match.guildId, binding);
      continue;
    }
    if (binding.match.guildId && !binding.match.roles) {
      pushToIndexMap(byGuild, binding.match.guildId, binding);
      continue;
    }
    if (binding.match.teamId) {
      pushToIndexMap(byTeam, binding.match.teamId, binding);
      continue;
    }
    if (binding.match.accountPattern !== "*") {
      byAccount.push(binding);
      continue;
    }
    byChannel.push(binding);
  }

  return {
    byPeer,
    byPeerWildcard,
    byGuildWithRoles,
    byGuild,
    byTeam,
    byAccount,
    byChannel,
  };
}

function getEvaluatedBindingsForChannelAccount(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): EvaluatedBinding[] {
  const bindingsRef = cfg.bindings;
  const existing = evaluatedBindingsCacheByCfg.get(cfg);
  const cache =
    existing && existing.bindingsRef === bindingsRef
      ? existing
      : {
          bindingsRef,
          byChannel: buildEvaluatedBindingsByChannel(cfg),
          byChannelAccount: new Map<string, EvaluatedBinding[]>(),
          byChannelAccountIndex: new Map<string, EvaluatedBindingsIndex>(),
        };
  if (cache !== existing) {
    evaluatedBindingsCacheByCfg.set(cfg, cache);
  }

  const cacheKey = `${channel}\t${accountId}`;
  const hit = cache.byChannelAccount.get(cacheKey);
  if (hit) {
    return hit;
  }

  const channelBindings = cache.byChannel.get(channel);
  const accountScoped = channelBindings?.byAccount.get(accountId) ?? [];
  const anyAccount = channelBindings?.byAnyAccount ?? [];
  const evaluated = mergeEvaluatedBindingsInSourceOrder(accountScoped, anyAccount);

  cache.byChannelAccount.set(cacheKey, evaluated);
  cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
  if (cache.byChannelAccount.size > MAX_EVALUATED_BINDINGS_CACHE_KEYS) {
    cache.byChannelAccount.clear();
    cache.byChannelAccountIndex.clear();
    cache.byChannelAccount.set(cacheKey, evaluated);
    cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
  }

  return evaluated;
}

function getEvaluatedBindingIndexForChannelAccount(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): EvaluatedBindingsIndex {
  const bindings = getEvaluatedBindingsForChannelAccount(cfg, channel, accountId);
  const existing = evaluatedBindingsCacheByCfg.get(cfg);
  const cacheKey = `${channel}\t${accountId}`;
  const indexed = existing?.byChannelAccountIndex.get(cacheKey);
  if (indexed) {
    return indexed;
  }
  const built = buildEvaluatedBindingsIndex(bindings);
  existing?.byChannelAccountIndex.set(cacheKey, built);
  return built;
}

/** @internal Lists matchable candidates from the canonical channel/account binding index. */
export function listChannelAccountRouteBindings(
  input: Pick<ResolveAgentRouteInput, "cfg" | "channel" | "accountId">,
) {
  return getEvaluatedBindingsForChannelAccount(
    input.cfg,
    normalizeLowercaseStringOrEmpty(input.channel),
    normalizeAccountId(input.accountId),
  ).map(({ binding }) => binding);
}

/** @internal Lists exact DM peers from the canonical channel/account binding index. */
export function listExactDirectMessageBindingPeerIds(
  input: Pick<ResolveAgentRouteInput, "cfg" | "channel" | "accountId">,
): string[] {
  const prefix = "direct:";
  return [
    ...getEvaluatedBindingIndexForChannelAccount(
      input.cfg,
      normalizeLowercaseStringOrEmpty(input.channel),
      normalizeAccountId(input.accountId),
    ).byPeer.keys(),
  ].flatMap((key) => (key.startsWith(prefix) ? [key.slice(prefix.length)] : []));
}

function normalizePeerConstraint(
  peer: { kind?: string; id?: string } | undefined,
): NormalizedPeerConstraint {
  if (!peer) {
    return { state: "none" };
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeRouteBindingId(peer.id);
  if (!kind || !id) {
    return { state: "invalid" };
  }
  if (id === "*") {
    return { state: "wildcard-kind", kind };
  }
  return { state: "valid", kind, id };
}

function normalizeBindingMatch(
  match:
    | {
        accountId?: string | undefined;
        peer?: { kind?: string; id?: string } | undefined;
        guildId?: string | undefined;
        teamId?: string | undefined;
        roles?: string[] | undefined;
      }
    | undefined,
): NormalizedBindingMatch {
  const rawRoles = match?.roles;
  return {
    accountPattern: (match?.accountId ?? "").trim(),
    peer: normalizePeerConstraint(match?.peer),
    guildId: normalizeRouteBindingId(match?.guildId) || null,
    teamId: normalizeRouteBindingId(match?.teamId) || null,
    roles: normalizeRouteBindingRoles(rawRoles),
  };
}

function resolveRouteCacheForConfig(cfg: OpenClawConfig): Map<string, ResolvedAgentRoute> {
  const existing = resolvedRouteCacheByCfg.get(cfg);
  if (
    existing &&
    existing.bindingsRef === cfg.bindings &&
    existing.agentsRef === cfg.agents &&
    existing.sessionRef === cfg.session
  ) {
    return existing.byKey;
  }
  const byKey = new Map<string, ResolvedAgentRoute>();
  resolvedRouteCacheByCfg.set(cfg, {
    bindingsRef: cfg.bindings,
    agentsRef: cfg.agents,
    sessionRef: cfg.session,
    byKey,
  });
  return byKey;
}

function formatRouteCachePeer(peer: RoutePeer | null): string {
  // Empty IDs still enable kind-specific wildcard routing, so only a missing peer is peerless.
  if (!peer) {
    return "-";
  }
  return `${peer.kind}:${peer.id}`;
}

function buildResolvedRouteCacheKey(params: {
  channel: string;
  defaultAgentId: string;
  accountId: string;
  peer: RoutePeer | null;
  parentPeer: RoutePeer | null;
  guildId: string;
  teamId: string;
  memberRoleIds: string[];
  dmScope: string;
  groupScope: string;
}): string {
  return JSON.stringify([
    params.channel,
    params.defaultAgentId,
    params.accountId,
    formatRouteCachePeer(params.peer),
    formatRouteCachePeer(params.parentPeer),
    params.guildId ?? null,
    params.teamId ?? null,
    params.memberRoleIds.toSorted(),
    params.dmScope,
    params.groupScope,
  ]);
}

function matchesBindingScope(match: NormalizedBindingMatch, scope: BindingScope): boolean {
  if (match.peer.state === "valid") {
    if (
      !scope.peer ||
      !peerKindMatches(match.peer.kind, scope.peer.kind) ||
      scope.peer.id !== match.peer.id
    ) {
      return false;
    }
  }
  if (match.peer.state === "wildcard-kind") {
    if (!scope.peer || !peerKindMatches(match.peer.kind, scope.peer.kind)) {
      return false;
    }
  }
  return routeBindingScopeMatches(match, scope);
}

export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  const channel = normalizeLowercaseStringOrEmpty(input.channel);
  const defaultAgentId = normalizeLowercaseStringOrEmpty(input.defaultAgentId);
  const accountId = normalizeAccountId(input.accountId);
  const peer = input.peer
    ? {
        kind: normalizeChatType(input.peer.kind) ?? input.peer.kind,
        id: normalizeRouteBindingId(input.peer.id),
      }
    : null;
  const guildId = normalizeRouteBindingId(input.guildId);
  const teamId = normalizeRouteBindingId(input.teamId);
  const memberRoleIds = input.memberRoleIds ?? [];
  const memberRoleIdSet = new Set(memberRoleIds);
  const dmScope = input.dmScope ?? input.cfg.session?.dmScope ?? "main";
  const groupScope = input.groupScope ?? input.cfg.session?.groupScope ?? "per-group";
  const identityLinks = input.cfg.session?.identityLinks;
  const shouldLogDebug = shouldLogVerbose();
  const parentPeer = input.parentPeer
    ? {
        kind: normalizeChatType(input.parentPeer.kind) ?? input.parentPeer.kind,
        id: normalizeRouteBindingId(input.parentPeer.id),
      }
    : null;

  const routeCache =
    !shouldLogDebug && !identityLinks ? resolveRouteCacheForConfig(input.cfg) : null;
  const routeCacheKey = routeCache
    ? buildResolvedRouteCacheKey({
        channel,
        defaultAgentId,
        accountId,
        peer,
        parentPeer,
        guildId,
        teamId,
        memberRoleIds,
        dmScope,
        groupScope,
      })
    : "";
  if (routeCache && routeCacheKey) {
    const cachedRoute = routeCache.get(routeCacheKey);
    if (cachedRoute) {
      return { ...cachedRoute };
    }
  }

  const bindings = getEvaluatedBindingsForChannelAccount(input.cfg, channel, accountId);
  const bindingsIndex = getEvaluatedBindingIndexForChannelAccount(input.cfg, channel, accountId);

  const choose = (
    agentId: string,
    matchedBy: ResolvedAgentRoute["matchedBy"],
    sessionOverride?: { dmScope?: DmScope; groupScope?: GroupScope },
  ) => {
    const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
    const effectiveDmScope = sessionOverride?.dmScope ?? dmScope;
    const effectiveGroupScope = sessionOverride?.groupScope ?? groupScope;
    const sessionKey = buildAgentSessionKey({
      agentId: resolvedAgentId,
      mainKey: input.cfg.session?.mainKey,
      channel,
      accountId,
      peer,
      dmScope: effectiveDmScope,
      groupScope: effectiveGroupScope,
      identityLinks,
    });
    const mainSessionKey = normalizeLowercaseStringOrEmpty(
      buildAgentMainSessionKey({
        agentId: resolvedAgentId,
        mainKey: input.cfg.session?.mainKey,
      }),
    );
    const route = {
      agentId: resolvedAgentId,
      channel,
      accountId,
      dmScope: effectiveDmScope,
      groupScope: effectiveGroupScope,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
      matchedBy,
    };
    if (routeCache && routeCacheKey) {
      routeCache.set(routeCacheKey, route);
      if (routeCache.size > MAX_RESOLVED_ROUTE_CACHE_KEYS) {
        routeCache.clear();
        routeCache.set(routeCacheKey, route);
      }
    }
    return route;
  };

  const formatPeer = (value?: RoutePeer | null) =>
    value?.kind && value?.id ? `${value.kind}:${value.id}` : "none";
  const formatNormalizedPeer = (value: NormalizedPeerConstraint) => {
    if (value.state === "none") {
      return "none";
    }
    if (value.state === "invalid") {
      return "invalid";
    }
    if (value.state === "wildcard-kind") {
      return `${value.kind}:*`;
    }
    return `${value.kind}:${value.id}`;
  };

  if (shouldLogDebug) {
    logDebug(
      `[routing] resolveAgentRoute: channel=${channel} accountId=${accountId} peer=${formatPeer(peer)} guildId=${guildId || "none"} teamId=${teamId || "none"} bindings=${bindings.length}`,
    );
    for (const entry of bindings) {
      logDebug(
        `[routing] binding: agentId=${entry.binding.agentId} accountPattern=${entry.match.accountPattern || "default"} peer=${formatNormalizedPeer(entry.match.peer)} guildId=${entry.match.guildId ?? "none"} teamId=${entry.match.teamId ?? "none"} roles=${entry.match.roles?.length ?? 0}`,
      );
    }
  }
  // Thread parent inheritance: if peer (thread) didn't match, check parent peer binding
  const baseScope = {
    guildId,
    teamId,
    memberRoleIds: memberRoleIdSet,
  };

  const tiers: Array<{
    matchedBy: Exclude<ResolvedAgentRoute["matchedBy"], "default">;
    enabled: boolean;
    scopePeer: RoutePeer | null;
    candidates: EvaluatedBinding[];
  }> = [
    {
      matchedBy: "binding.peer",
      enabled: Boolean(peer),
      scopePeer: peer,
      candidates: collectPeerIndexedBindings(bindingsIndex, peer),
    },
    {
      matchedBy: "binding.peer.parent",
      enabled: Boolean(parentPeer && parentPeer.id),
      scopePeer: parentPeer && parentPeer.id ? parentPeer : null,
      candidates: collectPeerIndexedBindings(bindingsIndex, parentPeer),
    },
    {
      matchedBy: "binding.peer.wildcard",
      enabled: Boolean(peer),
      scopePeer: peer,
      candidates: bindingsIndex.byPeerWildcard,
    },
    {
      matchedBy: "binding.guild+roles",
      enabled: Boolean(guildId && memberRoleIds.length > 0),
      scopePeer: peer,
      candidates: guildId ? (bindingsIndex.byGuildWithRoles.get(guildId) ?? []) : [],
    },
    {
      matchedBy: "binding.guild",
      enabled: Boolean(guildId),
      scopePeer: peer,
      candidates: guildId ? (bindingsIndex.byGuild.get(guildId) ?? []) : [],
    },
    {
      matchedBy: "binding.team",
      enabled: Boolean(teamId),
      scopePeer: peer,
      candidates: teamId ? (bindingsIndex.byTeam.get(teamId) ?? []) : [],
    },
    {
      matchedBy: "binding.account",
      enabled: true,
      scopePeer: peer,
      candidates: bindingsIndex.byAccount,
    },
    {
      matchedBy: "binding.channel",
      enabled: true,
      scopePeer: peer,
      candidates: bindingsIndex.byChannel,
    },
  ];

  for (const tier of tiers) {
    if (!tier.enabled) {
      continue;
    }
    // Index buckets already enforce tier membership; only route scope still
    // needs validation against this inbound peer, guild, team, and roles.
    const matched = tier.candidates.find((candidate) =>
      matchesBindingScope(candidate.match, {
        ...baseScope,
        peer: tier.scopePeer,
      }),
    );
    if (matched) {
      if (shouldLogDebug) {
        logDebug(`[routing] match: matchedBy=${tier.matchedBy} agentId=${matched.binding.agentId}`);
      }
      return choose(matched.binding.agentId, tier.matchedBy, matched.binding.session);
    }
  }

  const unboundAgentId = defaultAgentId || tryResolveLegacyCompatibilityAgentId(input.cfg);
  return choose(
    unboundAgentId ??
      resolveDefaultAgentId(input.cfg, {
        surface: `${channel} account ${accountId} routing`,
        hint: `Add a channel-wide binding for ${channel}:${accountId} or configure a sole agent.`,
      }),
    "default",
  );
}

/** @internal Lists bindings selectable by at least one group/channel route under runtime precedence. */
export function listEffectiveGroupRouteBindings(cfg: OpenClawConfig) {
  const bindings = listBindings(cfg);
  const usedIds = new Set<string>();
  for (const binding of bindings) {
    usedIds.add(normalizeAccountId(binding.match.accountId));
    for (const value of [binding.match.peer?.id, binding.match.guildId, binding.match.teamId]) {
      const normalized = normalizeRouteBindingId(value);
      if (normalized) {
        usedIds.add(normalized);
      }
    }
  }
  let sentinel = "openclaw-audit-route";
  while (usedIds.has(sentinel)) {
    sentinel += "-next";
  }

  const markerForIndex = (index: number) => `audit-binding-${index}`;
  const probeCfg: OpenClawConfig = {
    ...cfg,
    agents: { entries: {} },
    bindings: bindings.map((binding, index) => ({ ...binding, agentId: markerForIndex(index) })),
  };

  return bindings.filter((binding, index) => {
    const match = normalizeBindingMatch(binding.match);
    if (
      match.peer.state === "invalid" ||
      ((match.peer.state === "valid" || match.peer.state === "wildcard-kind") &&
        match.peer.kind === "direct")
    ) {
      return false;
    }
    const peer: RoutePeer =
      match.peer.state === "valid"
        ? { kind: match.peer.kind, id: match.peer.id }
        : match.peer.state === "wildcard-kind"
          ? { kind: match.peer.kind, id: sentinel }
          : { kind: "group", id: sentinel };
    const accountId = match.accountPattern === "*" ? sentinel : match.accountPattern;
    const roleWitnesses = match.roles?.map((role) => [role]) ?? [[]];

    // Equality/wildcard fields need one fresh value for each open domain. Role matching
    // is positive OR, so singleton candidate roles prove existence without sampling.
    return roleWitnesses.some(
      (memberRoleIds) =>
        resolveAgentRoute({
          cfg: probeCfg,
          channel: binding.match.channel,
          defaultAgentId: DEFAULT_AGENT_ID,
          accountId,
          peer,
          guildId: match.guildId,
          teamId: match.teamId,
          memberRoleIds,
        }).agentId === markerForIndex(index),
    );
  });
}

/** @internal Resolves fallback precedence for an unknown direct peer. */
export function resolveUnknownDirectMessageRoute(
  input: Pick<ResolveAgentRouteInput, "cfg" | "channel" | "accountId" | "dmScope" | "groupScope">,
): ResolvedAgentRoute {
  return resolveAgentRoute({ ...input, peer: { kind: "direct", id: "" } });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
