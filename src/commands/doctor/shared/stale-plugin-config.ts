import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../../agents/agent-scope.js";
import { CHANNEL_IDS } from "../../../channels/ids.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizePluginId } from "../../../plugins/config-state.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../../../plugins/installed-plugin-index-records.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { defaultSlotIdForKey, type PluginSlotKey } from "../../../plugins/slots.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "./object.js";

const CHANNEL_CONFIG_META_KEYS = new Set(["defaults", "modelByChannel"]);

type StalePluginSurface =
  | "allow"
  | "deny"
  | "entries"
  | "slot"
  | "channel"
  | "heartbeat"
  | "modelByChannel";

type StalePluginConfigHit = {
  pluginId: string;
  pathLabel: string;
  surface: StalePluginSurface;
  slotKey?: PluginSlotKey;
};

type StalePluginRegistryState = {
  knownIds: Set<string>;
  knownChannelIds: Set<string>;
  missingInstalledIds: Set<string>;
  hasDiscoveryErrors: boolean;
};

function collectPluginRegistryState(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): StalePluginRegistryState {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const registry = loadManifestMetadataSnapshot({
    config: cfg,
    workspaceDir: workspaceDir ?? undefined,
    env: env ?? process.env,
  }).manifestRegistry;
  const knownIds = new Set(registry.plugins.map((plugin) => plugin.id));
  const installedIds = new Set<string>();
  for (const pluginId of Object.keys(cfg.plugins?.installs ?? {})) {
    const normalized = normalizePluginId(pluginId);
    if (normalized) {
      installedIds.add(normalized);
    }
  }
  try {
    for (const pluginId of Object.keys(loadInstalledPluginIndexInstallRecordsSync({ env }))) {
      const normalized = normalizePluginId(pluginId);
      if (normalized) {
        installedIds.add(normalized);
      }
    }
  } catch {
    // Missing/corrupt install-record state must not block normal doctor scans.
  }
  const knownChannelIds = new Set(CHANNEL_IDS.map((channelId) => normalizePluginId(channelId)));
  for (const plugin of registry.plugins) {
    for (const channelId of plugin.channels) {
      const normalized = normalizePluginId(channelId);
      if (normalized) {
        knownChannelIds.add(normalized);
      }
    }
  }
  return {
    knownIds,
    knownChannelIds,
    missingInstalledIds: new Set([...installedIds].filter((pluginId) => !knownIds.has(pluginId))),
    hasDiscoveryErrors: registry.diagnostics.some((diag) => diag.level === "error"),
  };
}

export function isStalePluginAutoRepairBlocked(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (cfg.plugins?.enabled === false) {
    return false;
  }
  return collectPluginRegistryState(cfg, env).hasDiscoveryErrors;
}

export function scanStalePluginConfig(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): StalePluginConfigHit[] {
  if (cfg.plugins?.enabled === false) {
    return [];
  }
  return scanStalePluginConfigWithState(cfg, collectPluginRegistryState(cfg, env));
}

function scanStalePluginConfigWithState(
  cfg: OpenClawConfig,
  registryState: StalePluginRegistryState,
): StalePluginConfigHit[] {
  const plugins = asObjectRecord(cfg.plugins);
  const { knownIds } = registryState;
  const hits: StalePluginConfigHit[] = [];
  const staleEvidenceIds = new Set(registryState.missingInstalledIds);

  const allow = Array.isArray(plugins?.allow) ? plugins.allow : [];
  for (const rawPluginId of allow) {
    if (typeof rawPluginId !== "string") {
      continue;
    }
    const pluginId = normalizePluginId(rawPluginId);
    if (!pluginId || knownIds.has(pluginId) || registryState.knownChannelIds.has(pluginId)) {
      continue;
    }
    hits.push({
      pluginId: rawPluginId,
      pathLabel: "plugins.allow",
      surface: "allow",
    });
    staleEvidenceIds.add(pluginId);
  }

  const deny = Array.isArray(plugins?.deny) ? plugins.deny : [];
  for (const rawPluginId of deny) {
    if (typeof rawPluginId !== "string") {
      continue;
    }
    const pluginId = normalizePluginId(rawPluginId);
    if (!pluginId || knownIds.has(pluginId) || registryState.knownChannelIds.has(pluginId)) {
      continue;
    }
    hits.push({
      pluginId: rawPluginId,
      pathLabel: "plugins.deny",
      surface: "deny",
    });
    staleEvidenceIds.add(pluginId);
  }

  const entries = asObjectRecord(plugins?.entries);
  if (entries) {
    for (const rawPluginId of Object.keys(entries)) {
      const pluginId = normalizePluginId(rawPluginId);
      if (!pluginId || knownIds.has(pluginId) || registryState.knownChannelIds.has(pluginId)) {
        continue;
      }
      hits.push({
        pluginId: rawPluginId,
        pathLabel: `plugins.entries.${rawPluginId}`,
        surface: "entries",
      });
      staleEvidenceIds.add(pluginId);
    }
  }

  const slots = asObjectRecord(plugins?.slots);
  if (slots) {
    for (const slotKey of ["memory", "contextEngine"] as const satisfies readonly PluginSlotKey[]) {
      const rawPluginId = slots[slotKey];
      if (typeof rawPluginId !== "string") {
        continue;
      }
      const pluginId = normalizePluginId(rawPluginId);
      const defaultSlotId = defaultSlotIdForKey(slotKey);
      if (
        !pluginId ||
        rawPluginId.trim().toLowerCase() === "none" ||
        pluginId === normalizePluginId(defaultSlotId) ||
        knownIds.has(pluginId)
      ) {
        continue;
      }
      hits.push({
        pluginId: rawPluginId,
        pathLabel: `plugins.slots.${slotKey}`,
        surface: "slot",
        slotKey,
      });
    }
  }

  const staleChannelIds = collectDanglingChannelIds({
    cfg,
    registryState,
    staleEvidenceIds,
  });
  for (const channelId of staleChannelIds) {
    hits.push({
      pluginId: channelId,
      pathLabel: `channels.${channelId}`,
      surface: "channel",
    });
  }
  for (const hit of collectDependentChannelConfigHits(cfg, staleChannelIds)) {
    hits.push(hit);
  }

  return hits;
}

function collectDanglingChannelIds(params: {
  cfg: OpenClawConfig;
  registryState: StalePluginRegistryState;
  staleEvidenceIds: ReadonlySet<string>;
}): string[] {
  const channels = asObjectRecord(params.cfg.channels);
  if (!channels) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const channelId of Object.keys(channels)) {
    if (CHANNEL_CONFIG_META_KEYS.has(channelId)) {
      continue;
    }
    const normalized = normalizePluginId(channelId);
    if (
      !normalized ||
      params.registryState.knownChannelIds.has(normalized) ||
      !params.staleEvidenceIds.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    ids.push(channelId);
  }
  return ids;
}

function collectDependentChannelConfigHits(
  cfg: OpenClawConfig,
  channelIds: readonly string[],
): StalePluginConfigHit[] {
  if (channelIds.length === 0) {
    return [];
  }
  const staleChannelIds = new Set(channelIds.map((channelId) => normalizePluginId(channelId)));
  const hits: StalePluginConfigHit[] = [];
  const defaultTarget = cfg.agents?.defaults?.heartbeat?.target;
  if (typeof defaultTarget === "string" && staleChannelIds.has(normalizePluginId(defaultTarget))) {
    hits.push({
      pluginId: defaultTarget,
      pathLabel: "agents.defaults.heartbeat.target",
      surface: "heartbeat",
    });
  }
  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const target = agent?.heartbeat?.target;
    if (typeof target !== "string" || !staleChannelIds.has(normalizePluginId(target))) {
      continue;
    }
    hits.push({
      pluginId: target,
      pathLabel: `agents.list.${index}.heartbeat.target`,
      surface: "heartbeat",
    });
  }

  const modelByChannel = asObjectRecord(cfg.channels?.modelByChannel);
  if (modelByChannel) {
    for (const [providerId, channelMap] of Object.entries(modelByChannel)) {
      const channels = asObjectRecord(channelMap);
      if (!channels) {
        continue;
      }
      for (const channelId of Object.keys(channels)) {
        if (!staleChannelIds.has(normalizePluginId(channelId))) {
          continue;
        }
        hits.push({
          pluginId: channelId,
          pathLabel: `channels.modelByChannel.${providerId}.${channelId}`,
          surface: "modelByChannel",
        });
      }
    }
  }

  return hits;
}

function formatStalePluginHitWarning(hit: StalePluginConfigHit): string {
  if (hit.surface === "allow" || hit.surface === "deny" || hit.surface === "entries") {
    return `- ${hit.pathLabel}: stale plugin reference "${hit.pluginId}" was found.`;
  }
  if (hit.surface === "slot") {
    return `- ${hit.pathLabel}: slot references missing plugin "${hit.pluginId}".`;
  }
  if (hit.surface === "channel") {
    return `- ${hit.pathLabel}: dangling channel config for missing plugin "${hit.pluginId}" was found.`;
  }
  if (hit.surface === "heartbeat") {
    return `- ${hit.pathLabel}: heartbeat target references missing channel plugin "${hit.pluginId}".`;
  }
  return `- ${hit.pathLabel}: model override references missing channel plugin "${hit.pluginId}".`;
}

export function collectStalePluginConfigWarnings(params: {
  hits: StalePluginConfigHit[];
  doctorFixCommand: string;
  autoRepairBlocked?: boolean;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const lines = params.hits.map((hit) => formatStalePluginHitWarning(hit));
  if (params.autoRepairBlocked) {
    lines.push(
      `- Auto-removal is paused because plugin discovery currently has errors. Fix plugin discovery first, then rerun "${params.doctorFixCommand}".`,
    );
  } else {
    lines.push(
      `- Run "${params.doctorFixCommand}" to remove stale plugin ids and dangling channel references.`,
    );
  }
  return lines.map((line) => sanitizeForLog(line));
}

export function maybeRepairStalePluginConfig(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): {
  config: OpenClawConfig;
  changes: string[];
} {
  if (cfg.plugins?.enabled === false) {
    return { config: cfg, changes: [] };
  }
  const registryState = collectPluginRegistryState(cfg, env);
  if (registryState.hasDiscoveryErrors) {
    return { config: cfg, changes: [] };
  }

  const hits = scanStalePluginConfigWithState(cfg, registryState);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextPlugins = asObjectRecord(next.plugins);

  const allowIds = hits.filter((hit) => hit.surface === "allow").map((hit) => hit.pluginId);
  if (allowIds.length > 0 && Array.isArray(nextPlugins?.allow)) {
    const staleAllowIds = new Set(allowIds.map((pluginId) => normalizePluginId(pluginId)));
    nextPlugins.allow = nextPlugins.allow.filter(
      (pluginId) => typeof pluginId !== "string" || !staleAllowIds.has(normalizePluginId(pluginId)),
    );
  }

  const denyIds = hits.filter((hit) => hit.surface === "deny").map((hit) => hit.pluginId);
  if (denyIds.length > 0 && Array.isArray(nextPlugins?.deny)) {
    const staleDenyIds = new Set(denyIds.map((pluginId) => normalizePluginId(pluginId)));
    nextPlugins.deny = nextPlugins.deny.filter(
      (pluginId) => typeof pluginId !== "string" || !staleDenyIds.has(normalizePluginId(pluginId)),
    );
  }

  const entryIds = hits.filter((hit) => hit.surface === "entries").map((hit) => hit.pluginId);
  if (entryIds.length > 0) {
    const entries = asObjectRecord(nextPlugins?.entries);
    if (entries) {
      const staleEntryIds = new Set(entryIds.map((pluginId) => normalizePluginId(pluginId)));
      for (const pluginId of Object.keys(entries)) {
        if (staleEntryIds.has(normalizePluginId(pluginId))) {
          delete entries[pluginId];
        }
      }
    }
  }

  const slotHits = hits.filter(
    (hit): hit is StalePluginConfigHit & { slotKey: PluginSlotKey } =>
      hit.surface === "slot" && hit.slotKey !== undefined,
  );
  if (slotHits.length > 0) {
    const slots = asObjectRecord(nextPlugins?.slots);
    if (slots) {
      for (const hit of slotHits) {
        slots[hit.slotKey] = defaultSlotIdForKey(hit.slotKey);
      }
    }
  }

  const channelIds = hits.filter((hit) => hit.surface === "channel").map((hit) => hit.pluginId);
  if (channelIds.length > 0) {
    removeDanglingChannelReferences(next, channelIds);
  }

  const changes: string[] = [];
  if (allowIds.length > 0) {
    changes.push(
      `- plugins.allow: removed ${allowIds.length} stale plugin id${allowIds.length === 1 ? "" : "s"} (${allowIds.join(", ")})`,
    );
  }
  if (denyIds.length > 0) {
    changes.push(
      `- plugins.deny: removed ${denyIds.length} stale plugin id${denyIds.length === 1 ? "" : "s"} (${denyIds.join(", ")})`,
    );
  }
  if (entryIds.length > 0) {
    changes.push(
      `- plugins.entries: removed ${entryIds.length} stale plugin entr${entryIds.length === 1 ? "y" : "ies"} (${entryIds.join(", ")})`,
    );
  }
  if (slotHits.length > 0) {
    changes.push(
      `- plugins.slots: reset ${slotHits.length} stale plugin slot${slotHits.length === 1 ? "" : "s"} (${slotHits.map((hit) => `${hit.slotKey}: ${hit.pluginId} -> ${defaultSlotIdForKey(hit.slotKey)}`).join(", ")})`,
    );
  }
  if (channelIds.length > 0) {
    changes.push(
      `- channels: removed ${channelIds.length} stale channel config${channelIds.length === 1 ? "" : "s"} (${channelIds.join(", ")})`,
    );
    const heartbeatCount = hits.filter((hit) => hit.surface === "heartbeat").length;
    if (heartbeatCount > 0) {
      changes.push(
        `- agents heartbeat: removed ${heartbeatCount} stale heartbeat target${heartbeatCount === 1 ? "" : "s"} (${channelIds.join(", ")})`,
      );
    }
    const modelByChannelCount = hits.filter((hit) => hit.surface === "modelByChannel").length;
    if (modelByChannelCount > 0) {
      changes.push(
        `- channels.modelByChannel: removed ${modelByChannelCount} stale channel model override${modelByChannelCount === 1 ? "" : "s"} (${channelIds.join(", ")})`,
      );
    }
  }

  return { config: next, changes };
}

function removeDanglingChannelReferences(config: OpenClawConfig, channelIds: readonly string[]) {
  const staleChannelIds = new Set(channelIds.map((channelId) => normalizePluginId(channelId)));
  const channels = asObjectRecord(config.channels);
  if (channels) {
    for (const channelId of Object.keys(channels)) {
      if (CHANNEL_CONFIG_META_KEYS.has(channelId)) {
        continue;
      }
      if (staleChannelIds.has(normalizePluginId(channelId))) {
        delete channels[channelId];
      }
    }

    const modelByChannel = asObjectRecord(channels.modelByChannel);
    if (modelByChannel) {
      for (const [providerId, channelMap] of Object.entries(modelByChannel)) {
        const channelsForProvider = asObjectRecord(channelMap);
        if (!channelsForProvider) {
          continue;
        }
        for (const channelId of Object.keys(channelsForProvider)) {
          if (staleChannelIds.has(normalizePluginId(channelId))) {
            delete channelsForProvider[channelId];
          }
        }
        if (Object.keys(channelsForProvider).length === 0) {
          delete modelByChannel[providerId];
        }
      }
      if (Object.keys(modelByChannel).length === 0) {
        delete channels.modelByChannel;
      }
    }
  }

  const defaultsHeartbeat = config.agents?.defaults?.heartbeat;
  if (
    defaultsHeartbeat &&
    typeof defaultsHeartbeat.target === "string" &&
    staleChannelIds.has(normalizePluginId(defaultsHeartbeat.target))
  ) {
    delete defaultsHeartbeat.target;
  }
  for (const agent of config.agents?.list ?? []) {
    const heartbeat = agent.heartbeat;
    if (
      heartbeat &&
      typeof heartbeat.target === "string" &&
      staleChannelIds.has(normalizePluginId(heartbeat.target))
    ) {
      delete heartbeat.target;
    }
  }
}
