import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeRouteBindingChannelId,
  normalizeRouteBindingId,
  normalizeRouteBindingRoles,
  resolveNormalizedRouteBindingMatch,
  routeBindingScopeMatches,
} from "./binding-scope.js";
import { peerKindMatches } from "./peer-kind-match.js";
import { normalizeAgentId } from "./session-key.js";

function resolveNormalizedBoundAccountMatch(binding: AgentRouteBinding): {
  agentId: string;
  accountId: string;
  channelId: string;
  peerId?: string;
  peerKind?: ChatType;
  guildId?: string | null;
  teamId?: string | null;
  roles?: string[] | null;
} | null {
  const baseMatch = resolveNormalizedRouteBindingMatch(binding);
  const match = binding.match;
  if (!baseMatch || !match || typeof match !== "object") {
    return null;
  }
  const peerId = match.peer && typeof match.peer.id === "string" ? match.peer.id.trim() : undefined;
  const peerKind = match.peer ? normalizeChatType(match.peer.kind) : undefined;
  return {
    ...baseMatch,
    peerId: peerId || undefined,
    peerKind: peerKind ?? undefined,
    guildId: normalizeRouteBindingId(match.guildId) || null,
    teamId: normalizeRouteBindingId(match.teamId) || null,
    roles: normalizeRouteBindingRoles(match.roles),
  };
}

function buildExactPeerIdSet(params: {
  peerId?: string;
  exactPeerIdAliases?: string[];
}): Set<string> {
  const exactPeerIds = new Set<string>();
  const peerId = params.peerId?.trim();
  if (peerId) {
    exactPeerIds.add(peerId);
  }
  for (const alias of params.exactPeerIdAliases ?? []) {
    const trimmed = alias.trim();
    if (trimmed) {
      exactPeerIds.add(trimmed);
    }
  }
  return exactPeerIds;
}

export function resolveFirstBoundAccountId(params: {
  cfg: OpenClawConfig;
  channelId: string;
  agentId: string;
  peerId?: string;
  exactPeerIdAliases?: string[];
  peerKind?: ChatType;
  groupSpace?: string | null;
  memberRoleIds?: string[];
}): string | undefined {
  const normalizedChannel = normalizeRouteBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const normalizedPeerId = params.peerId?.trim() || undefined;
  const exactPeerIds = buildExactPeerIdSet({
    peerId: normalizedPeerId,
    exactPeerIdAliases: params.exactPeerIdAliases,
  });
  const hasPeerContext = exactPeerIds.size > 0;
  const normalizedPeerKind = normalizeChatType(params.peerKind) ?? undefined;
  let wildcardPeerMatch: string | undefined;
  let channelOnlyFallback: string | undefined;
  for (const binding of listRouteBindings(params.cfg)) {
    const resolved = resolveNormalizedBoundAccountMatch(binding);
    if (
      !resolved ||
      resolved.channelId !== normalizedChannel ||
      resolved.agentId !== normalizedAgentId
    ) {
      continue;
    }
    if (
      !routeBindingScopeMatches(resolved, {
        groupSpace: params.groupSpace,
        memberRoleIds: params.memberRoleIds,
      })
    ) {
      continue;
    }
    if (!hasPeerContext) {
      // Cron and other peerless callers historically used the first matching
      // agent/channel binding. Keep that fallback order unless the caller has
      // enough peer context for the stricter exact/wildcard routing below.
      return resolved.accountId;
    }
    if (resolved.peerId === "*") {
      // Caller has a peer. Wildcard bindings are only safe when both sides
      // declare a peer kind AND the kinds agree — a direct/* binding must
      // never win for a channel caller (or vice versa), and we'd rather fall
      // through to channel-only or the caller account than actively route to
      // the wrong identity.
      if (
        !resolved.peerKind ||
        !normalizedPeerKind ||
        !peerKindMatches(resolved.peerKind, normalizedPeerKind)
      ) {
        continue;
      }
      wildcardPeerMatch ??= resolved.accountId;
    } else if (resolved.peerId) {
      // Exact peer id match: peer ids are channel-unique so id alone is
      // sufficient, but when both sides declare a kind they must still agree
      // (avoids a direct-kind binding matching a channel caller that happens
      // to share an id, which can occur on channels where ids are reused
      // across kinds).
      if (
        resolved.peerKind &&
        normalizedPeerKind &&
        !peerKindMatches(resolved.peerKind, normalizedPeerKind)
      ) {
        continue;
      }
      if (exactPeerIds.has(resolved.peerId)) {
        return resolved.accountId;
      }
    } else {
      channelOnlyFallback ??= resolved.accountId;
    }
  }
  return wildcardPeerMatch ?? channelOnlyFallback;
}
