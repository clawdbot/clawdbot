import { normalizeChatChannelId } from "../channels/ids.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeAccountId, normalizeAgentId } from "./session-key.js";

export type RouteBindingScopeConstraint = {
  guildId?: string | null;
  teamId?: string | null;
  roles?: string[] | null;
};

export type RouteBindingScope = {
  guildId?: string | null;
  teamId?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: Iterable<string> | null;
};

export type NormalizedRouteBindingMatch = {
  agentId: string;
  accountId: string;
  channelId: string;
};

export function normalizeRouteBindingId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

export function normalizeRouteBindingRoles(value: string[] | null | undefined): string[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

export function normalizeRouteBindingChannelId(raw?: string | null): string | null {
  const normalized = normalizeChatChannelId(raw);
  if (normalized) {
    return normalized;
  }
  const fallback = normalizeLowercaseStringOrEmpty(raw);
  return fallback || null;
}

export function resolveNormalizedRouteBindingMatch(
  binding: AgentRouteBinding,
): NormalizedRouteBindingMatch | null {
  if (!binding || typeof binding !== "object") {
    return null;
  }
  const match = binding.match;
  if (!match || typeof match !== "object") {
    return null;
  }
  const channelId = normalizeRouteBindingChannelId(match.channel);
  if (!channelId) {
    return null;
  }
  const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
  if (!accountId || accountId === "*") {
    return null;
  }
  return {
    agentId: normalizeAgentId(binding.agentId),
    accountId: normalizeAccountId(accountId),
    channelId,
  };
}

function scopeIdMatches(params: {
  constraint: string | null | undefined;
  exact: string;
  groupSpace: string;
}): boolean {
  if (!params.constraint) {
    return true;
  }
  return params.constraint === params.exact || params.constraint === params.groupSpace;
}

function hasRoleLookup(
  memberRoleIds: Iterable<string>,
): memberRoleIds is Iterable<string> & { has(roleId: string): boolean } {
  return typeof (memberRoleIds as { has?: unknown }).has === "function";
}

function hasAnyRouteBindingRole(
  roles: readonly string[],
  memberRoleIds: Iterable<string> | null | undefined,
): boolean {
  if (!memberRoleIds) {
    return false;
  }
  if (hasRoleLookup(memberRoleIds)) {
    return roles.some((role) => memberRoleIds.has(role));
  }
  const memberRoleIdSet = new Set(memberRoleIds);
  return roles.some((role) => memberRoleIdSet.has(role));
}

export function routeBindingScopeMatches(
  constraint: RouteBindingScopeConstraint,
  scope: RouteBindingScope,
): boolean {
  const guildId = normalizeRouteBindingId(scope.guildId);
  const teamId = normalizeRouteBindingId(scope.teamId);
  const groupSpace = normalizeRouteBindingId(scope.groupSpace);
  if (!scopeIdMatches({ constraint: constraint.guildId, exact: guildId, groupSpace })) {
    return false;
  }
  if (!scopeIdMatches({ constraint: constraint.teamId, exact: teamId, groupSpace })) {
    return false;
  }

  const roles = normalizeRouteBindingRoles(constraint.roles);
  if (!roles) {
    return true;
  }
  return hasAnyRouteBindingRole(roles, scope.memberRoleIds);
}
