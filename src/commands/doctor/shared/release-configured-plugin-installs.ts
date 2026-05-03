import { collectConfiguredAgentHarnessRuntimes } from "../../../agents/harness-runtimes.js";
import { listPotentialConfiguredChannelPresenceSignals } from "../../../channels/config-presence.js";
import { normalizeChatChannelId } from "../../../channels/registry.js";
import { isChannelConfigured } from "../../../config/channel-configured.js";
import { detectPluginAutoEnableCandidates } from "../../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { compareOpenClawVersions } from "../../../config/version.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { resolveWebSearchInstallCatalogEntry } from "../../../plugins/web-search-install-catalog.js";
import { VERSION } from "../../../version.js";
import { repairMissingPluginInstallsForIds } from "./missing-configured-plugin-install.js";
import { asObjectRecord } from "./object.js";

export const CONFIGURED_PLUGIN_INSTALL_RELEASE_VERSION = "2026.5.2-beta.1";

const AGENT_HARNESS_RUNTIME_PLUGIN_IDS: Readonly<Record<string, string>> = {
  // Codex can be selected as a harness for OpenAI models without a plugin entry.
  codex: "codex",
};

type ReleaseConfiguredPluginIds = {
  pluginIds: string[];
  channelIds: string[];
};

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPluginsGloballyDisabled(cfg: OpenClawConfig): boolean {
  return cfg.plugins?.enabled === false;
}

function isDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function collectBlockedPluginIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const deny = cfg.plugins?.deny;
  if (Array.isArray(deny)) {
    for (const pluginId of deny) {
      const normalized = normalizeId(pluginId);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
  const entries = asObjectRecord(cfg.plugins?.entries);
  for (const [pluginId, entry] of Object.entries(entries ?? {})) {
    if (asObjectRecord(entry)?.enabled === false && pluginId.trim()) {
      ids.add(pluginId.trim());
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

function isPluginEntryDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function isChannelDisabled(cfg: OpenClawConfig, channelId: string): boolean {
  const channels = asObjectRecord(cfg.channels);
  const entry = asObjectRecord(channels?.[channelId]);
  return entry?.enabled === false;
}

function isDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  if (isPluginEntryDisabled(cfg, pluginId)) {
    return true;
  }
  const channelId = normalizeChatChannelId(pluginId);
  return channelId ? isChannelDisabled(cfg, channelId) : false;
}

function hasMaterialPluginEntry(entry: unknown): boolean {
  const record = asObjectRecord(entry);
  if (!record) {
    return false;
  }
  return (
    record.enabled === true ||
    asObjectRecord(record.config) !== null ||
    asObjectRecord(record.hooks) !== null ||
    asObjectRecord(record.subagent) !== null ||
    record.apiKey !== undefined ||
    record.env !== undefined
  );
}

function collectMaterialPluginEntryIds(cfg: OpenClawConfig): string[] {
  const entries = asObjectRecord(cfg.plugins?.entries);
  if (!entries) {
    return [];
  }
  return Object.entries(entries)
    .filter(([, entry]) => hasMaterialPluginEntry(entry))
    .map(([pluginId]) => pluginId.trim())
    .filter((pluginId) => pluginId);
}

function collectSlotPluginIds(cfg: OpenClawConfig): string[] {
  const slots = asObjectRecord(cfg.plugins?.slots);
  return ["memory", "contextEngine"]
    .map((key) => normalizeId(slots?.[key]))
    .filter((pluginId): pluginId is string => !!pluginId && pluginId.toLowerCase() !== "none");
}

function collectConfiguredChannelIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const ids = new Set<string>();
  const channels = asObjectRecord(cfg.channels);
  if (channels) {
    for (const [channelId, value] of Object.entries(channels)) {
      if (channelId === "defaults" || channelId === "modelByChannel" || !channelId.trim()) {
        continue;
      }
      const entry = asObjectRecord(value);
      if (entry?.enabled === false) {
        continue;
      }
      if (entry?.enabled === true || Object.keys(entry ?? {}).some((key) => key !== "enabled")) {
        ids.add(channelId.trim());
      }
    }
  }
  for (const signal of listPotentialConfiguredChannelPresenceSignals(cfg, env, {
    includePersistedAuthState: false,
  })) {
    const channelId = normalizeChatChannelId(signal.channelId) ?? signal.channelId;
    if (!isChannelDisabled(cfg, channelId) && isChannelConfigured(cfg, channelId, env)) {
      ids.add(channelId);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

function collectConfiguredProviderIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  for (const profile of Object.values(asObjectRecord(cfg.auth?.profiles) ?? {})) {
    add(asObjectRecord(profile)?.provider);
  }
  for (const providerId of Object.keys(asObjectRecord(cfg.models?.providers) ?? {})) {
    add(providerId);
  }
  const collectModelRef = (value: unknown) => {
    const ref = normalizeId(value);
    const slash = ref?.indexOf("/") ?? -1;
    if (ref && slash > 0) {
      add(ref.slice(0, slash));
    }
  };
  const collectModelConfig = (value: unknown) => {
    if (typeof value === "string") {
      collectModelRef(value);
      return;
    }
    const record = asObjectRecord(value);
    if (!record) {
      return;
    }
    collectModelRef(record.primary);
    if (Array.isArray(record.fallbacks)) {
      for (const fallback of record.fallbacks) {
        collectModelRef(fallback);
      }
    }
  };
  const collectAgent = (agent: unknown) => {
    const record = asObjectRecord(agent);
    if (!record) {
      return;
    }
    for (const key of [
      "model",
      "imageGenerationModel",
      "videoGenerationModel",
      "musicGenerationModel",
    ]) {
      collectModelConfig(record[key]);
    }
    for (const modelRef of Object.keys(asObjectRecord(record.models) ?? {})) {
      collectModelRef(modelRef);
    }
  };
  collectAgent(cfg.agents?.defaults);
  for (const agent of Array.isArray(cfg.agents?.list) ? cfg.agents.list : []) {
    collectAgent(agent);
  }
  return ids;
}

function collectProviderPluginIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const configuredProviders = collectConfiguredProviderIds(cfg);
  if (configuredProviders.size === 0) {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of resolveProviderInstallCatalogEntries({
    config: cfg,
    env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    if (configuredProviders.has(entry.providerId.toLowerCase())) {
      ids.add(entry.pluginId);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

function collectAgentHarnessRuntimePluginIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  return collectConfiguredAgentHarnessRuntimes(cfg, env)
    .map((runtime) => AGENT_HARNESS_RUNTIME_PLUGIN_IDS[runtime])
    .filter((pluginId): pluginId is string => Boolean(pluginId))
    .toSorted((left, right) => left.localeCompare(right));
}

function collectWebSearchPluginIds(cfg: OpenClawConfig): string[] {
  const providerId = cfg.tools?.web?.search?.provider;
  if (typeof providerId !== "string") {
    return [];
  }
  const entry = resolveWebSearchInstallCatalogEntry({ providerId });
  return entry?.pluginId ? [entry.pluginId] : [];
}

function collectAcpRuntimePluginIds(cfg: OpenClawConfig): string[] {
  const acp = asObjectRecord(cfg.acp);
  if (!acp) {
    return [];
  }
  const backend = normalizeId(acp.backend)?.toLowerCase() ?? "";
  const configured =
    acp.enabled === true || asObjectRecord(acp.dispatch)?.enabled === true || backend === "acpx";
  if (!configured || (backend && backend !== "acpx")) {
    return [];
  }
  return ["acpx"];
}

function addEligiblePluginId(cfg: OpenClawConfig, pluginIds: Set<string>, pluginId: string): void {
  const normalized = pluginId.trim();
  if (!normalized || isDenied(cfg, normalized) || isDisabled(cfg, normalized)) {
    return;
  }
  pluginIds.add(normalized);
}

export function shouldRunConfiguredPluginInstallReleaseStep(params: {
  currentVersion?: string | null;
  touchedVersion?: string | null;
  releaseVersion?: string;
}): boolean {
  const releaseVersion = params.releaseVersion ?? CONFIGURED_PLUGIN_INSTALL_RELEASE_VERSION;
  const currentComparedToRelease = compareOpenClawVersions(
    params.currentVersion ?? VERSION,
    releaseVersion,
  );
  if (currentComparedToRelease === null || currentComparedToRelease < 0) {
    return false;
  }
  const touchedComparedToRelease = compareOpenClawVersions(params.touchedVersion, releaseVersion);
  return touchedComparedToRelease === null || touchedComparedToRelease < 0;
}

export function collectReleaseConfiguredPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ReleaseConfiguredPluginIds {
  const env = params.env ?? process.env;
  const pluginIds = new Set<string>();
  const channelIds = new Set<string>();
  if (isPluginsGloballyDisabled(params.cfg)) {
    return { pluginIds: [], channelIds: [] };
  }

  for (const candidate of detectPluginAutoEnableCandidates({
    config: params.cfg,
    env,
  })) {
    addEligiblePluginId(params.cfg, pluginIds, candidate.pluginId);
  }
  for (const pluginId of collectMaterialPluginEntryIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectSlotPluginIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectProviderPluginIds(params.cfg, env)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectAgentHarnessRuntimePluginIds(params.cfg, env)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectWebSearchPluginIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectAcpRuntimePluginIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const channelId of collectConfiguredChannelIds(params.cfg, env)) {
    if (
      !isChannelDisabled(params.cfg, channelId) &&
      !isDenied(params.cfg, channelId) &&
      !isPluginEntryDisabled(params.cfg, channelId)
    ) {
      channelIds.add(channelId);
    }
  }

  return {
    pluginIds: [...pluginIds].toSorted((left, right) => left.localeCompare(right)),
    channelIds: [...channelIds].toSorted((left, right) => left.localeCompare(right)),
  };
}

export async function maybeRunConfiguredPluginInstallReleaseStep(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  touchedVersion?: string | null;
  currentVersion?: string | null;
}): Promise<{
  changes: string[];
  warnings: string[];
  completed: boolean;
  touchedConfig: boolean;
}> {
  if (
    !shouldRunConfiguredPluginInstallReleaseStep({
      currentVersion: params.currentVersion,
      touchedVersion: params.touchedVersion,
    })
  ) {
    return { changes: [], warnings: [], completed: false, touchedConfig: false };
  }
  const env = params.env ?? process.env;
  const configured = collectReleaseConfiguredPluginIds({ cfg: params.cfg, env });
  if (configured.pluginIds.length === 0 && configured.channelIds.length === 0) {
    return { changes: [], warnings: [], completed: true, touchedConfig: true };
  }
  const repaired = await repairMissingPluginInstallsForIds({
    cfg: params.cfg,
    pluginIds: configured.pluginIds,
    channelIds: configured.channelIds,
    blockedPluginIds: collectBlockedPluginIds(params.cfg),
    env,
  });
  const completed = repaired.warnings.length === 0;
  return {
    changes: repaired.changes,
    warnings: repaired.warnings,
    completed,
    touchedConfig: completed,
  };
}
