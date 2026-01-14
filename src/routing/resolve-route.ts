import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "./session-key.js";

export type RoutePeerKind = "dm" | "group" | "channel";

export type RoutePeer = {
  kind: RoutePeerKind;
  id: string;
};

export type ResolveAgentRouteInput = {
  cfg: ClawdbotConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
};

export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  /** Internal session key used for persistence + concurrency. */
  sessionKey: string;
  /** Convenience alias for direct-chat collapse. */
  mainSessionKey: string;
  /** Match description for debugging/logging. */
  matchedBy:
    | "binding.peer"
    | "binding.guild"
    | "binding.team"
    | "binding.account"
    | "binding.channel"
    | "default";
};

export { DEFAULT_ACCOUNT_ID, DEFAULT_AGENT_ID } from "./session-key.js";

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeId(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : DEFAULT_ACCOUNT_ID;
}

function matchesAccountId(match: string | undefined, actual: string): boolean {
  const trimmed = (match ?? "").trim();
  if (!trimmed) return actual === DEFAULT_ACCOUNT_ID;
  if (trimmed === "*") return true;
  return trimmed === actual;
}

export function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  peer?: RoutePeer | null;
}): string {
  const channel = normalizeToken(params.channel) || "unknown";
  const peer = params.peer;
  return buildAgentPeerSessionKey({
    agentId: params.agentId,
    mainKey: DEFAULT_MAIN_KEY,
    channel,
    peerKind: peer?.kind ?? "dm",
    peerId: peer ? normalizeId(peer.id) || "unknown" : null,
  });
}

function listBindings(cfg: ClawdbotConfig) {
  const bindings = cfg.bindings;
  return Array.isArray(bindings) ? bindings : [];
}

function listAgents(cfg: ClawdbotConfig) {
  const agents = cfg.agents?.list;
  return Array.isArray(agents) ? agents : [];
}

function pickFirstExistingAgentId(
  cfg: ClawdbotConfig,
  agentId: string,
): string {
  const normalized = normalizeAgentId(agentId);
  const agents = listAgents(cfg);
  if (agents.length === 0) return normalized;
  if (agents.some((agent) => normalizeAgentId(agent.id) === normalized)) {
    return normalized;
  }
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

function matchesChannel(
  match: { channel?: string | undefined } | undefined,
  channel: string,
): boolean {
  const key = normalizeToken(match?.channel);
  if (!key) return false;
  return key === channel;
}

function matchesPeer(
  match: { peer?: { kind?: string; id?: string } | undefined } | undefined,
  peer: RoutePeer,
): boolean {
  const m = match?.peer;
  if (!m) return false;
  const kind = normalizeToken(m.kind);
  const id = normalizeId(m.id);
  if (!kind || !id) return false;
  return kind === peer.kind && id === peer.id;
}

function matchesGuild(
  match: { guildId?: string | undefined } | undefined,
  guildId: string,
): boolean {
  const id = normalizeId(match?.guildId);
  if (!id) return false;
  return id === guildId;
}

function matchesTeam(
  match: { teamId?: string | undefined } | undefined,
  teamId: string,
): boolean {
  const id = normalizeId(match?.teamId);
  if (!id) return false;
  return id === teamId;
}

export function resolveAgentRoute(
  input: ResolveAgentRouteInput,
): ResolvedAgentRoute {
  const channel = normalizeToken(input.channel);
  const accountId = normalizeAccountId(input.accountId);
  const peer = input.peer
    ? { kind: input.peer.kind, id: normalizeId(input.peer.id) }
    : null;
  const guildId = normalizeId(input.guildId);
  const teamId = normalizeId(input.teamId);

  const bindings = listBindings(input.cfg).filter((binding) => {
    if (!binding || typeof binding !== "object") return false;
    if (!matchesChannel(binding.match, channel)) return false;
    return matchesAccountId(binding.match?.accountId, accountId);
  });

  const choose = (
    agentId: string,
    matchedBy: ResolvedAgentRoute["matchedBy"],
  ) => {
    const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
    return {
      agentId: resolvedAgentId,
      channel,
      accountId,
      sessionKey: buildAgentSessionKey({
        agentId: resolvedAgentId,
        channel,
        peer,
      }),
      mainSessionKey: buildAgentMainSessionKey({
        agentId: resolvedAgentId,
        mainKey: DEFAULT_MAIN_KEY,
      }),
      matchedBy,
    };
  };

  if (peer) {
    const peerMatch = bindings.find((b) => matchesPeer(b.match, peer));
    if (peerMatch) return choose(peerMatch.agentId, "binding.peer");
  }

  if (guildId) {
    const guildMatch = bindings.find((b) => matchesGuild(b.match, guildId));
    if (guildMatch) return choose(guildMatch.agentId, "binding.guild");
  }

  if (teamId) {
    const teamMatch = bindings.find((b) => matchesTeam(b.match, teamId));
    if (teamMatch) return choose(teamMatch.agentId, "binding.team");
  }

  const accountMatch = bindings.find(
    (b) =>
      b.match?.accountId?.trim() !== "*" &&
      !b.match?.peer &&
      !b.match?.guildId &&
      !b.match?.teamId,
  );
  if (accountMatch) return choose(accountMatch.agentId, "binding.account");

  const anyAccountMatch = bindings.find(
    (b) =>
      b.match?.accountId?.trim() === "*" &&
      !b.match?.peer &&
      !b.match?.guildId &&
      !b.match?.teamId,
  );
  if (anyAccountMatch)
    return choose(anyAccountMatch.agentId, "binding.channel");

  return choose(resolveDefaultAgentId(input.cfg), "default");
}
