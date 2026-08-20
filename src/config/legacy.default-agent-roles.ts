import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, tryResolveSoleAgentId } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";
import { normalizeRouteBindingChannelId } from "../routing/binding-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { isPerAgentSessionStoreConfig } from "./sessions/session-store-config.js";
import type { AgentRouteBinding } from "./types.agents.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function isChannelWideBinding(binding: AgentRouteBinding, channelId: string): boolean {
  const match = binding.match;
  return (
    isRecord(match) &&
    normalizeRouteBindingChannelId(
      typeof match.channel === "string" ? match.channel : undefined,
    ) === channelId &&
    (typeof match.accountId === "string" ? match.accountId.trim() : undefined) === "*" &&
    match.peer === undefined &&
    !normalizeOptionalString(typeof match.guildId === "string" ? match.guildId : undefined) &&
    !normalizeOptionalString(typeof match.teamId === "string" ? match.teamId : undefined) &&
    (!Array.isArray(match.roles) || match.roles.length === 0)
  );
}

function listUnboundAmbientChannelIds(
  cfg: OpenClawConfig,
  ambientChannelIds: readonly string[],
): string[] {
  if (cfg.bindings && !Array.isArray(cfg.bindings)) {
    return [];
  }
  const bindings = (cfg.bindings ?? []).filter(
    (binding): binding is AgentRouteBinding => isRecord(binding) && binding.type !== "acp",
  );
  const channels = new Set(
    ambientChannelIds.map(normalizeRouteBindingChannelId).filter((id): id is string => Boolean(id)),
  );
  if (isRecord(cfg.channels)) {
    for (const [id, value] of Object.entries(cfg.channels)) {
      const channelId = normalizeRouteBindingChannelId(id);
      if (
        channelId &&
        !isChannelConfigMetadataKey(id) &&
        (!isRecord(value) || value.enabled !== false)
      ) {
        channels.add(channelId);
      }
    }
  }
  return [...channels]
    .toSorted()
    .filter((channelId) => !bindings.some((binding) => isChannelWideBinding(binding, channelId)));
}

export function materializeLegacyDefaultAgentRoles(
  cfg: OpenClawConfig,
  legacyDefaultAgentId: string,
  options: {
    ambientChannelIds?: readonly string[];
    env?: NodeJS.ProcessEnv;
    materializeSessionStore?: boolean;
    materializeWorkspace?: boolean;
  } = {},
) {
  const agentId = normalizeAgentId(legacyDefaultAgentId);
  let next = cfg;
  const insertedPaths: string[][] = [];
  if (options.materializeWorkspace) {
    const entries = { ...next.agents?.entries };
    const entryKey = Object.keys(entries).find(
      (candidate) => normalizeAgentId(candidate) === agentId,
    );
    const entry = entryKey ? entries[entryKey] : undefined;
    const workspaceNeedsPin =
      entry !== undefined &&
      (!Object.hasOwn(entry, "workspace") ||
        (typeof entry.workspace === "string" && entry.workspace.trim().length === 0));
    if (entryKey && entry && workspaceNeedsPin) {
      entries[entryKey] = {
        ...entry,
        workspace:
          normalizeOptionalString(next.agents?.defaults?.workspace) ??
          resolveDefaultAgentWorkspaceDir(options.env),
      };
      next = { ...next, agents: { ...next.agents, entries } };
      insertedPaths.push(["agents", "entries", entryKey, "workspace"]);
    }
  }
  const channels = listUnboundAmbientChannelIds(cfg, options.ambientChannelIds ?? []);
  if (channels.length > 0) {
    next = {
      ...next,
      bindings: [
        ...(Array.isArray(next.bindings) ? next.bindings : []),
        ...channels.map((channel) => ({ agentId, match: { channel, accountId: "*" } })),
      ],
    };
    insertedPaths.push(["bindings"]);
  }

  const rawDefaults = (cfg.agents as { defaults?: unknown } | undefined)?.defaults;
  const defaults = isRecord(rawDefaults) ? rawDefaults : undefined;
  if (rawDefaults === undefined || defaults) {
    const soleFallback = normalizeAgentId(tryResolveSoleAgentId(cfg) ?? "main");
    const unset = (key: string) =>
      defaults?.[key] === undefined ||
      (isRecord(defaults[key]) && !Object.hasOwn(defaults[key], "agentId"));
    const materializedDefaults = { ...defaults };
    let changed = false;
    const materialize = (key: string, enabled: boolean) => {
      if (!enabled) {
        return;
      }
      materializedDefaults[key] = {
        ...(isRecord(materializedDefaults[key]) ? materializedDefaults[key] : {}),
        agentId,
      };
      insertedPaths.push(["agents", "defaults", key, "agentId"]);
      changed = true;
    };
    materialize(
      "heartbeat",
      !listAgentEntries(cfg).some((entry) => entry.heartbeat) && defaults?.heartbeat === undefined,
    );
    materialize("systemAgent", unset("systemAgent"));
    // Auth transitions are pinned or refused by the roster write guard; fixed-store rows need
    // their owner recorded immediately because a later restart loses the migration sidecar.
    materialize("authInheritance", agentId !== soleFallback && unset("authInheritance"));
    materialize(
      "sessionStore",
      options.materializeSessionStore !== false &&
        !isPerAgentSessionStoreConfig(cfg.session?.store) &&
        unset("sessionStore"),
    );
    if (changed) {
      next = { ...next, agents: { ...next.agents, defaults: materializedDefaults } };
    }
  }

  const talk = isRecord(cfg.talk) ? cfg.talk : undefined;
  if ((cfg.talk === undefined || talk) && (!talk || !Object.hasOwn(talk, "agentId"))) {
    next = { ...next, talk: { ...talk, agentId } };
    insertedPaths.push(["talk", "agentId"]);
  }
  return { config: next, insertedPaths };
}
