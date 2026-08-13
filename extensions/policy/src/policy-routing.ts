import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const ROUTING_MATCH_KINDS = [
  "binding.peer",
  "binding.peer.parent",
  "binding.peer.wildcard",
  "binding.guild+roles",
  "binding.guild",
  "binding.team",
  "binding.account",
  "binding.channel",
  "default",
] as const satisfies readonly ResolvedAgentRoute["matchedBy"][];

type PolicyRoutingProbe = {
  readonly id: string;
  readonly route: {
    readonly channel: string;
    readonly accountId?: string;
    readonly peer?: RoutePeer;
    readonly parentPeer?: RoutePeer;
    readonly guildId?: string;
    readonly teamId?: string;
    readonly memberRoleIds?: readonly string[];
  };
  readonly expect: {
    readonly agentId: string;
    readonly matchedBy?: readonly ResolvedAgentRoute["matchedBy"][];
  };
};

export type PolicyRoutingRules = {
  readonly requireBindings?: boolean;
  readonly requireConfiguredChannels?: boolean;
  readonly probes?: readonly PolicyRoutingProbe[];
};

type PolicyRouteBinding = {
  readonly index: number;
  readonly channel: string;
};

export function policyRoutingRules(policy: unknown): PolicyRoutingRules | undefined {
  if (!isRecord(policy) || !isRecord(policy.routing)) {
    return undefined;
  }
  return policy.routing as PolicyRoutingRules;
}

export function listPolicyRouteBindings(
  cfg: Record<string, unknown>,
): readonly PolicyRouteBinding[] {
  if (!Array.isArray(cfg.bindings)) {
    return [];
  }
  const bindings: PolicyRouteBinding[] = [];
  for (const [index, value] of cfg.bindings.entries()) {
    if (!isRecord(value) || value.type === "acp" || !isRecord(value.match)) {
      continue;
    }
    if (typeof value.agentId !== "string" || typeof value.match.channel !== "string") {
      continue;
    }
    bindings.push({ index, channel: value.match.channel });
  }
  return bindings;
}

export function resolvePolicyRoutingProbe(
  cfg: Record<string, unknown>,
  probe: PolicyRoutingProbe,
): ResolvedAgentRoute {
  return resolveAgentRoute({
    cfg: cfg as OpenClawConfig,
    channel: probe.route.channel,
    accountId: probe.route.accountId,
    peer: probe.route.peer,
    parentPeer: probe.route.parentPeer,
    guildId: probe.route.guildId,
    teamId: probe.route.teamId,
    memberRoleIds:
      probe.route.memberRoleIds === undefined ? undefined : [...probe.route.memberRoleIds],
  });
}
