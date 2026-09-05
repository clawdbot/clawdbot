// Repairs canonical binding references after agent config migration.
import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { AgentSelectionRequiredError, listAgentIds } from "../../../agents/agent-scope-config.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../../channels/plugins/read-only.js";
import type { AgentRouteBinding } from "../../../config/types.agents.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveNormalizedAccountEntry } from "../../../routing/account-lookup.js";
import {
  listChannelAccountRouteBindings,
  resolveAgentRoute,
} from "../../../routing/resolve-route.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAccountId,
  normalizeAgentId,
} from "../../../routing/session-key.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";

export function pruneBindingsForMissingAgents(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const agents = cfg.agents?.list;
  const bindings = cfg.bindings;
  if (!Array.isArray(agents) || agents.length === 0 || !Array.isArray(bindings)) {
    return cfg;
  }

  const validAgents = agents.filter((agent): agent is { id: string } => {
    return agent !== null && typeof agent === "object" && typeof agent.id === "string";
  });
  if (validAgents.length !== agents.length) {
    return cfg;
  }

  const agentIds = new Set(validAgents.map((agent) => normalizeAgentId(agent.id)));
  const nextBindings = bindings.filter((binding) => {
    const agentId = binding && typeof binding === "object" ? binding.agentId : undefined;
    return (
      typeof agentId !== "string" ||
      agentId === DEFAULT_AGENT_ID ||
      agentIds.has(normalizeAgentId(agentId))
    );
  });
  const removed = bindings.length - nextBindings.length;
  if (removed === 0) {
    return cfg;
  }

  changes.push(
    `Removed ${removed} binding${removed === 1 ? "" : "s"} that referenced missing agents.list ids.`,
  );
  return {
    ...cfg,
    ...(nextBindings.length > 0 ? { bindings: nextBindings } : { bindings: undefined }),
  };
}

/** Materialize only channel-account owners already established by narrower route bindings. */
export function repairUnownedChannelAccountBindings(
  cfg: OpenClawConfig,
): DoctorConfigMutationResult {
  const agentIds = new Set(listAgentIds(cfg));
  const additions: AgentRouteBinding[] = [];
  // Malformed or ownerless bindings cannot establish an explicit repair owner.
  if (
    agentIds.size < 2 ||
    cfg.plugins?.enabled === false ||
    !Array.isArray(cfg.bindings) ||
    cfg.bindings.length === 0 ||
    !cfg.bindings.every(
      (binding) =>
        isRecord(binding) &&
        isRecord(binding.match) &&
        typeof binding.agentId === "string" &&
        binding.agentId.trim().length > 0 &&
        typeof binding.match.channel === "string" &&
        (binding.match.accountId === undefined || typeof binding.match.accountId === "string"),
    )
  ) {
    return { config: cfg, changes: [] };
  }
  const inventory = resolveReadOnlyChannelPluginsForConfig(cfg, {
    includePersistedAuthState: false,
    includeSetupFallbackPlugins: true,
  });
  const plugins = new Map(inventory.plugins.map((plugin) => [plugin.id, plugin]));
  for (const channelId of [...inventory.configuredChannelIds].toSorted()) {
    const plugin = plugins.get(channelId);
    const channel = asNullableRecord(cfg.channels?.[channelId]);
    if (!plugin || channel?.enabled === false) {
      continue;
    }
    const accounts = asNullableRecord(channel?.accounts) ?? undefined;
    const accountIds = [
      ...new Set(plugin.config.listAccountIds(cfg).map(normalizeAccountId)),
    ].toSorted();
    for (const accountId of accountIds) {
      const account = resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
      if (asNullableRecord(account)?.enabled === false) {
        continue;
      }
      const routeInput = { cfg, channel: channelId, accountId };
      try {
        resolveAgentRoute(routeInput);
        continue;
      } catch (error) {
        if (!(error instanceof AgentSelectionRequiredError)) {
          throw error;
        }
      }
      const owners = new Set(
        listChannelAccountRouteBindings(routeInput).map((binding) =>
          normalizeAgentId(binding.agentId),
        ),
      );
      const [agentId] = owners;
      if (owners.size === 1 && agentId && agentIds.has(agentId)) {
        // An exact account fallback preserves narrower precedence and never assigns sibling accounts.
        additions.push({ agentId, match: { channel: channelId, accountId } });
      }
    }
  }
  return {
    config: additions.length ? { ...cfg, bindings: [...cfg.bindings, ...additions] } : cfg,
    changes: additions.map(
      ({ agentId, match }) =>
        `Bound ${match.channel}:${match.accountId} to its sole configured route owner "${agentId}".`,
    ),
  };
}
