import { getBundledChannelSetupPlugin } from "../channels/plugins/bundled.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeChannelId as normalizeBundledChannelId } from "../channels/registry.js";
import { isRouteBinding, listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listPluginContributionIds,
  loadPluginRegistrySnapshot,
} from "../plugins/plugin-registry.js";
import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import type { ChannelChoice } from "./onboard-types.js";

export { describeBinding } from "./agents.binding-format.js";

function bindingMatchKey(match: AgentRouteBinding["match"]) {
  const accountId = normalizeOptionalString(match.accountId) || DEFAULT_ACCOUNT_ID;
  const identityKey = bindingMatchIdentityKey(match);
  return JSON.stringify([identityKey, accountId]);
}

function bindingMatchIdentityKey(match: AgentRouteBinding["match"]) {
  const roles = Array.isArray(match.roles)
    ? Array.from(new Set(normalizeStringEntries(match.roles).toSorted()))
    : [];
  return JSON.stringify([
    match.channel,
    match.peer?.kind ?? "",
    match.peer?.id ?? "",
    match.guildId ?? "",
    match.teamId ?? "",
    roles.join(","),
  ]);
}

function canUpgradeBindingAccountScope(params: {
  existing: AgentRouteBinding;
  incoming: AgentRouteBinding;
  normalizedIncomingAgentId: string;
}): boolean {
  if (!normalizeOptionalString(params.incoming.match.accountId)) {
    return false;
  }
  if (normalizeOptionalString(params.existing.match.accountId)) {
    return false;
  }
  if (normalizeAgentId(params.existing.agentId) !== params.normalizedIncomingAgentId) {
    return false;
  }
  return (
    bindingMatchIdentityKey(params.existing.match) ===
    bindingMatchIdentityKey(params.incoming.match)
  );
}

export function applyAgentBindings(
  cfg: OpenClawConfig,
  bindings: AgentRouteBinding[],
): {
  config: OpenClawConfig;
  added: AgentRouteBinding[];
  updated: AgentRouteBinding[];
  skipped: AgentRouteBinding[];
  conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>;
} {
  const existingRoutes = [...listRouteBindings(cfg)];
  const nonRouteBindings = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
  const existingMatchMap = new Map<string, string>();
  for (const binding of existingRoutes) {
    const key = bindingMatchKey(binding.match);
    if (!existingMatchMap.has(key)) {
      existingMatchMap.set(key, normalizeAgentId(binding.agentId));
    }
  }

  const added: AgentRouteBinding[] = [];
  const updated: AgentRouteBinding[] = [];
  const skipped: AgentRouteBinding[] = [];
  const conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }> = [];

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

    const upgradeIndex = existingRoutes.findIndex((candidate) =>
      canUpgradeBindingAccountScope({
        existing: candidate,
        incoming: binding,
        normalizedIncomingAgentId: agentId,
      }),
    );
    if (upgradeIndex >= 0) {
      const current = existingRoutes[upgradeIndex];
      if (!current) {
        continue;
      }
      const previousKey = bindingMatchKey(current.match);
      const upgradedBinding: AgentRouteBinding = {
        ...current,
        agentId,
        match: {
          ...current.match,
          accountId: binding.match.accountId?.trim(),
        },
      };
      existingRoutes[upgradeIndex] = upgradedBinding;
      existingMatchMap.delete(previousKey);
      existingMatchMap.set(bindingMatchKey(upgradedBinding.match), agentId);
      updated.push(upgradedBinding);
      continue;
    }

    existingMatchMap.set(key, agentId);
    added.push({ ...binding, agentId });
  }

  if (added.length === 0 && updated.length === 0) {
    return { config: cfg, added, updated, skipped, conflicts };
  }

  return {
    config: {
      ...cfg,
      bindings: [...existingRoutes, ...added, ...nonRouteBindings],
    },
    added,
    updated,
    skipped,
    conflicts,
  };
}

export function removeAgentBindings(
  cfg: OpenClawConfig,
  bindings: AgentRouteBinding[],
): {
  config: OpenClawConfig;
  removed: AgentRouteBinding[];
  missing: AgentRouteBinding[];
  conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>;
} {
  const existingRoutes = listRouteBindings(cfg);
  const nonRouteBindings = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
  const removeIndexes = new Set<number>();
  const removed: AgentRouteBinding[] = [];
  const missing: AgentRouteBinding[] = [];
  const conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }> = [];

  for (const binding of bindings) {
    const desiredAgentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    let matchedIndex = -1;
    let conflictingAgentId: string | null = null;
    for (let i = 0; i < existingRoutes.length; i += 1) {
      if (removeIndexes.has(i)) {
        continue;
      }
      const current = existingRoutes[i];
      if (!current || bindingMatchKey(current.match) !== key) {
        continue;
      }
      const currentAgentId = normalizeAgentId(current.agentId);
      if (currentAgentId === desiredAgentId) {
        matchedIndex = i;
        break;
      }
      conflictingAgentId = currentAgentId;
    }
    if (matchedIndex >= 0) {
      const matched = existingRoutes[matchedIndex];
      if (matched) {
        removeIndexes.add(matchedIndex);
        removed.push(matched);
      }
      continue;
    }
    if (conflictingAgentId) {
      conflicts.push({ binding, existingAgentId: conflictingAgentId });
      continue;
    }
    missing.push(binding);
  }

  if (removeIndexes.size === 0) {
    return { config: cfg, removed, missing, conflicts };
  }

  const nextRouteBindings = existingRoutes.filter((_, index) => !removeIndexes.has(index));
  const nextBindings = [...nextRouteBindings, ...nonRouteBindings];
  return {
    config: {
      ...cfg,
      bindings: nextBindings.length > 0 ? nextBindings : undefined,
    },
    removed,
    missing,
    conflicts,
  };
}

function resolveDefaultAccountId(cfg: OpenClawConfig, provider: ChannelId): string {
  const plugin = getBindingChannelPlugin(provider);
  if (!plugin) {
    return DEFAULT_ACCOUNT_ID;
  }
  return resolveChannelDefaultAccountId({ plugin, cfg });
}

function listManifestChannelIds(config: OpenClawConfig): Set<string> {
  const index = loadPluginRegistrySnapshot({
    config,
    env: process.env,
  });
  return new Set(
    listPluginContributionIds({
      index,
      contribution: "channels",
      includeDisabled: true,
      config,
    }),
  );
}

function normalizeBindingChannelId(
  raw: string | undefined,
  config: OpenClawConfig,
): ChannelId | null {
  const bundled = normalizeBundledChannelId(raw);
  if (bundled) {
    return bundled;
  }
  const normalized = normalizeOptionalString(raw)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  return listManifestChannelIds(config).has(normalized) ? normalized : null;
}

function getBindingChannelPlugin(channel: ChannelId) {
  return getLoadedChannelPlugin(channel) ?? getBundledChannelSetupPlugin(channel);
}

function resolveBindingAccountId(params: {
  channel: ChannelId;
  config: OpenClawConfig;
  agentId: string;
  explicitAccountId?: string;
}): string | undefined {
  const explicitAccountId = params.explicitAccountId?.trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }

  const plugin = getBindingChannelPlugin(params.channel);
  const pluginAccountId = plugin?.setup?.resolveBindingAccountId?.({
    cfg: params.config,
    agentId: params.agentId,
  });
  if (pluginAccountId?.trim()) {
    return pluginAccountId.trim();
  }

  if (plugin?.meta.forceAccountBinding) {
    return resolveDefaultAccountId(params.config, params.channel);
  }

  return undefined;
}

export function buildChannelBindings(params: {
  agentId: string;
  selection: ChannelChoice[];
  config: OpenClawConfig;
  accountIds?: Partial<Record<ChannelChoice, string>>;
}): AgentRouteBinding[] {
  const bindings: AgentRouteBinding[] = [];
  const agentId = normalizeAgentId(params.agentId);
  for (const channel of params.selection) {
    const match: AgentRouteBinding["match"] = { channel };
    const accountId = resolveBindingAccountId({
      channel,
      config: params.config,
      agentId,
      explicitAccountId: params.accountIds?.[channel],
    });
    if (accountId) {
      match.accountId = accountId;
    }
    bindings.push({ type: "route", agentId, match });
  }
  return bindings;
}

export function parseBindingSpecs(params: {
  agentId: string;
  specs?: string[];
  config: OpenClawConfig;
}): { bindings: AgentRouteBinding[]; errors: string[] } {
  const bindings: AgentRouteBinding[] = [];
  const errors: string[] = [];
  const specs = params.specs ?? [];
  const agentId = normalizeAgentId(params.agentId);
  for (const raw of specs) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    const [channelRaw, accountRaw] = trimmed.split(":", 2);
    const channel = normalizeBindingChannelId(channelRaw, params.config);
    if (!channel) {
      errors.push(`Unknown channel "${channelRaw}".`);
      continue;
    }
    let accountId: string | undefined = accountRaw?.trim();
    if (accountRaw !== undefined && !accountId) {
      errors.push(`Invalid binding "${trimmed}" (empty account id).`);
      continue;
    }
    accountId = resolveBindingAccountId({
      channel,
      config: params.config,
      agentId,
      explicitAccountId: accountId,
    });
    const match: AgentRouteBinding["match"] = { channel };
    if (accountId) {
      match.accountId = accountId;
    }
    bindings.push({ type: "route", agentId, match });
  }
  return { bindings, errors };
}
