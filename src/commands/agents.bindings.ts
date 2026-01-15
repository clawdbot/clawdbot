import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { ChannelChoice } from "./onboard-types.js";

function bindingMatchKey(match: AgentBinding["match"]) {
  const accountId = match.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  return [
    match.channel,
    accountId,
    match.peer?.kind ?? "",
    match.peer?.id ?? "",
    match.guildId ?? "",
    match.teamId ?? "",
  ].join("|");
}

export function describeBinding(binding: AgentBinding) {
  const match = binding.match;
  const parts = [match.channel];
  if (match.accountId) parts.push(`accountId=${match.accountId}`);
  if (match.peer) parts.push(`peer=${match.peer.kind}:${match.peer.id}`);
  if (match.guildId) parts.push(`guild=${match.guildId}`);
  if (match.teamId) parts.push(`team=${match.teamId}`);
  return parts.join(" ");
}

export function applyAgentBindings(
  cfg: ClawdbotConfig,
  bindings: AgentBinding[],
): {
  config: ClawdbotConfig;
  added: AgentBinding[];
  skipped: AgentBinding[];
  conflicts: Array<{ binding: AgentBinding; existingAgentId: string }>;
} {
  const existing = cfg.bindings ?? [];
  const existingMatchMap = new Map<string, string>();
  for (const binding of existing) {
    const key = bindingMatchKey(binding.match);
    if (!existingMatchMap.has(key)) {
      existingMatchMap.set(key, normalizeAgentId(binding.agentId));
    }
  }

  const added: AgentBinding[] = [];
  const skipped: AgentBinding[] = [];
  const conflicts: Array<{ binding: AgentBinding; existingAgentId: string }> = [];

  for (const binding of bindings) {
    const agentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    const existingAgentId = existingMatchMap.get(key);
    if (existingAgentId) {
      if (existingAgentId === agentId) {
        skipped.push(binding);
      } else {
        conflicts.push({ binding, existingAgentId });
      }
      continue;
    }
    existingMatchMap.set(key, agentId);
    added.push({ ...binding, agentId });
  }

  if (added.length === 0) {
    return { config: cfg, added, skipped, conflicts };
  }

  return {
    config: {
      ...cfg,
      bindings: [...existing, ...added],
    },
    added,
    skipped,
    conflicts,
  };
}

function resolveDefaultAccountId(cfg: ClawdbotConfig, provider: ChannelId): string {
  const plugin = getChannelPlugin(provider);
  if (!plugin) return DEFAULT_ACCOUNT_ID;
  return resolveChannelDefaultAccountId({ plugin, cfg });
}

export function buildChannelBindings(params: {
  agentId: string;
  selection: ChannelChoice[];
  config: ClawdbotConfig;
  accountIds?: Partial<Record<ChannelChoice, string>>;
}): AgentBinding[] {
  const bindings: AgentBinding[] = [];
  const agentId = normalizeAgentId(params.agentId);
  for (const channel of params.selection) {
    const match: AgentBinding["match"] = { channel };
    const accountId = params.accountIds?.[channel]?.trim();
    if (accountId) {
      match.accountId = accountId;
    } else {
      const plugin = getChannelPlugin(channel);
      if (plugin?.meta.forceAccountBinding) {
        match.accountId = resolveDefaultAccountId(params.config, channel);
      }
    }
    bindings.push({ agentId, match });
  }
  return bindings;
}

export function parseBindingSpecs(params: {
  agentId: string;
  specs?: string[];
  config: ClawdbotConfig;
}): { bindings: AgentBinding[]; errors: string[] } {
  const bindings: AgentBinding[] = [];
  const errors: string[] = [];
  const specs = params.specs ?? [];
  const agentId = normalizeAgentId(params.agentId);
  for (const raw of specs) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const [channelRaw, accountRaw] = trimmed.split(":", 2);
    const channel = normalizeChannelId(channelRaw);
    if (!channel) {
      errors.push(`Unknown channel "${channelRaw}".`);
      continue;
    }
    let accountId = accountRaw?.trim();
    if (accountRaw !== undefined && !accountId) {
      errors.push(`Invalid binding "${trimmed}" (empty account id).`);
      continue;
    }
    if (!accountId) {
      const plugin = getChannelPlugin(channel);
      if (plugin?.meta.forceAccountBinding) {
        accountId = resolveDefaultAccountId(params.config, channel);
      }
    }
    const match: AgentBinding["match"] = { channel };
    if (accountId) match.accountId = accountId;
    bindings.push({ agentId, match });
  }
  return { bindings, errors };
}
