import { listAgentEntries, listAgentIds } from "../agents/agent-scope-config.js";
import type { BroadcastStrategy } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAcpSessionKey, normalizeAgentId } from "../routing/session-key.js";
import { buildMentionRegexes, normalizeMentionText } from "./reply/mentions.js";

export type ResolvedGroupThreadConfig = {
  agents: string[];
  unknownAgentIds: string[];
  qualified: boolean;
  configuredAgentCount: number;
  mentionGating: boolean;
  maxRounds: number;
  maxTurns: number;
  strategy: BroadcastStrategy;
};

export type GroupThreadMentionFacts = {
  channel: string;
  peerId: string;
  group: ResolvedGroupThreadConfig;
  mentionedAgentIds: string[];
};

function boundedCount(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(
    1,
    Math.min(maximum, Math.floor(value !== undefined && Number.isFinite(value) ? value : fallback)),
  );
}

export function resolveGroupThreadConfig(params: {
  cfg: OpenClawConfig;
  channel: string;
  peerId: string;
}): ResolvedGroupThreadConfig | undefined {
  const { cfg, channel, peerId } = params;
  const qualifiedEntry = cfg.broadcast?.[`${channel}:${peerId}`];
  const qualified = qualifiedEntry !== undefined;
  const entry = qualifiedEntry ?? (channel === "whatsapp" ? cfg.broadcast?.[peerId] : undefined);
  if (!entry || typeof entry === "string") {
    return undefined;
  }
  const configuredAgents = Array.isArray(entry) ? entry : entry.agents;
  if (configuredAgents.length === 0) {
    return undefined;
  }
  const roster = new Set(listAgentIds(cfg));
  const requireKnownAgent =
    qualified || cfg.agents?.entries !== undefined || listAgentEntries(cfg).length > 0;
  const participants = qualified ? configuredAgents.slice(0, 16) : configuredAgents;
  const agents = [...new Set(participants.map(normalizeAgentId))].filter(
    (id) => !requireKnownAgent || roster.has(id),
  );
  return {
    agents,
    unknownAgentIds: requireKnownAgent
      ? participants.filter((id) => !roster.has(normalizeAgentId(id)))
      : [],
    qualified,
    configuredAgentCount: participants.length,
    mentionGating: qualified && (Array.isArray(entry) ? true : (entry.mentionGating ?? true)),
    maxRounds: !qualified || Array.isArray(entry) ? 1 : boundedCount(entry.maxRounds, 1, 4),
    maxTurns: !qualified
      ? agents.length
      : boundedCount(Array.isArray(entry) ? undefined : entry.maxTurns, participants.length, 32),
    strategy: cfg.broadcast?.strategy ?? "parallel",
  };
}

/** Only an explicit address selects a participant; names in prose and bare emoji do not. */
export function resolveGroupThreadMentionedAgentIds(
  cfg: OpenClawConfig,
  agents: readonly string[],
  text: string,
): string[] {
  const normalized = normalizeMentionText(text);
  if (!normalized.includes("@")) {
    return [];
  }
  return agents.filter((agentId) =>
    buildMentionRegexes(cfg, agentId).some((pattern) => {
      const matcher = new RegExp(pattern.source, `${pattern.flags.replaceAll("g", "")}g`);
      for (const match of normalized.matchAll(matcher)) {
        const start = match.index;
        const at = match[0].startsWith("@")
          ? start
          : match[0].startsWith("<@")
            ? start + 1
            : normalized[start - 1] === "@"
              ? start - 1
              : -1;
        if (at >= 0 && (at === 0 || !/[\p{L}\p{N}_]/u.test(normalized.charAt(at - 1)))) {
          return true;
        }
      }
      return false;
    }),
  );
}

export function isGroupThreadRouteExclusive(params: {
  sessionKey?: string;
  acpBinding?: boolean;
}): boolean {
  return Boolean(params.acpBinding) || isAcpSessionKey(params.sessionKey);
}

export function resolveGroupThreadMentionFacts(params: {
  cfg: OpenClawConfig;
  channel: string;
  peerId: string;
  text: string;
  sessionKey?: string;
  acpBinding?: boolean;
}): GroupThreadMentionFacts | undefined {
  if (isGroupThreadRouteExclusive(params)) {
    return undefined;
  }
  const group = resolveGroupThreadConfig(params);
  if (!group?.qualified) {
    return undefined;
  }
  return {
    channel: params.channel,
    peerId: params.peerId,
    group,
    mentionedAgentIds: resolveGroupThreadMentionedAgentIds(params.cfg, group.agents, params.text),
  };
}
