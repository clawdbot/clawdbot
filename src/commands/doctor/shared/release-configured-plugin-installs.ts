// Release-era repair for configs that imply official plugin installs before install records existed.
import { normalizeNullableString as normalizeId } from "@openclaw/normalization-core/string-coerce";
import { collectConfiguredAgentHarnessRuntimes } from "../../../agents/harness-runtimes.js";
import { listPotentialConfiguredChannelPresenceSignals } from "../../../channels/config-presence.js";
import { normalizeChatChannelId } from "../../../channels/registry.js";
import { isChannelConfigured } from "../../../config/channel-configured.js";
import { detectPluginAutoEnableCandidates } from "../../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { compareOpenClawVersions } from "../../../config/version.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../../../infra/update-doctor-result.js";
import { collectConfiguredSpeechProviderIds } from "../../../plugins/gateway-startup-speech-providers.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
} from "../../../plugins/official-external-plugin-catalog.js";
import {
  resolveWebSearchInstallCatalogEntriesForEnv,
  resolveWebSearchInstallCatalogEntry,
} from "../../../plugins/web-search-install-catalog.js";
import { VERSION } from "../../../version.js";
import { collectConfiguredProviderPluginIds } from "./configured-provider-plugin-installs.js";
import { repairMissingPluginInstallsForIds } from "./missing-configured-plugin-install.js";
import { asObjectRecord } from "./object.js";
import { shouldDeferConfiguredPluginInstallRepair } from "./update-phase.js";

const CONFIGURED_PLUGIN_INSTALL_RELEASE_VERSION = "2026.5.2-beta.1";

const AGENT_HARNESS_RUNTIME_PLUGIN_IDS: Readonly<Record<string, string>> = {
  // Codex can be selected as a harness for OpenAI models without a plugin entry.
  codex: "codex",
};

type ReleaseConfiguredPluginIds = {
  pluginIds: string[];
  channelIds: string[];
};

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
    .filter(
      (pluginId): pluginId is string =>
        typeof pluginId === "string" && pluginId.toLowerCase() !== "none",
    );
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

function collectAgentHarnessRuntimePluginIds(
  cfg: OpenClawConfig,
  _env: NodeJS.ProcessEnv,
): string[] {
  return collectConfiguredAgentHarnessRuntimes(cfg)
    .map((runtime) => AGENT_HARNESS_RUNTIME_PLUGIN_IDS[runtime])
    .filter((pluginId): pluginId is string => Boolean(pluginId))
    .toSorted((left, right) => left.localeCompare(right));
}

function collectWebSearchPluginIds(cfg: OpenClawConfig): string[] {
  if (cfg.tools?.web?.search?.enabled === false) {
    return [];
  }
  const providerId = cfg.tools?.web?.search?.provider;
  if (typeof providerId !== "string") {
    return [];
  }
  const entry = resolveWebSearchInstallCatalogEntry({ providerId });
  return entry?.pluginId ? [entry.pluginId] : [];
}

function collectEnvWebSearchPluginIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  if (cfg.tools?.web?.search?.enabled === false) {
    return [];
  }
  return resolveWebSearchInstallCatalogEntriesForEnv(env).map((entry) => entry.pluginId);
}

function collectWebFetchPluginIds(cfg: OpenClawConfig): string[] {
  const webFetch = cfg.tools?.web?.fetch;
  if (webFetch?.enabled === false) {
    return [];
  }
  const providerId = normalizeId(webFetch?.provider)?.toLowerCase();
  if (!providerId) {
    return [];
  }
  return resolveOfficialExternalProviderContractPluginIds({
    contract: "webFetchProviders",
    providerIds: new Set([providerId]),
  });
}

function collectEnvWebFetchPluginIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  if (cfg.tools?.web?.fetch?.enabled === false) {
    return [];
  }
  return resolveOfficialExternalWebProviderContractPluginIdsForEnv({
    contract: "webFetchProviders",
    env,
  });
}

function collectSpeechPluginIds(cfg: OpenClawConfig): string[] {
  return resolveOfficialExternalProviderContractPluginIds({
    contract: "speechProviders",
    providerIds: collectConfiguredSpeechProviderIds(cfg),
  });
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

function collectAllowOnlyOfficialPluginIds(cfg: OpenClawConfig): string[] {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return [];
  }
  const materialEntryIds = new Set(
    collectMaterialPluginEntryIds(cfg).map((id) => id.toLowerCase()),
  );
  const ids: string[] = [];
  for (const rawPluginId of allow) {
    const pluginId = normalizeId(rawPluginId);
    if (!pluginId || materialEntryIds.has(pluginId.toLowerCase())) {
      continue;
    }
    if (getOfficialExternalPluginCatalogEntry(pluginId)) {
      ids.push(pluginId);
    }
  }
  return ids;
}

function addEligiblePluginId(cfg: OpenClawConfig, pluginIds: Set<string>, pluginId: string): void {
  const normalized = pluginId.trim();
  if (!normalized || isDenied(cfg, normalized) || isDisabled(cfg, normalized)) {
    return;
  }
  pluginIds.add(normalized);
}

/** Return true when this config has not yet crossed the configured-plugin install release gate. */
function shouldRunConfiguredPluginInstallReleaseStep(params: {
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

/** Collect plugin/channel ids implied by config for the release install backfill step. */
function collectReleaseConfiguredPluginIds(params: {
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
  for (const pluginId of collectConfiguredProviderPluginIds({ cfg: params.cfg, env })) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectAgentHarnessRuntimePluginIds(params.cfg, env)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectWebSearchPluginIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectEnvWebSearchPluginIds(params.cfg, env)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectWebFetchPluginIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectEnvWebFetchPluginIds(params.cfg, env)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectSpeechPluginIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectAcpRuntimePluginIds(params.cfg)) {
    addEligiblePluginId(params.cfg, pluginIds, pluginId);
  }
  for (const pluginId of collectAllowOnlyOfficialPluginIds(params.cfg)) {
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

/** Run the configured-plugin install release backfill when the config still needs it. */
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
  postInstallDoctorResult?: UpdatePostInstallDoctorResult;
}> {
  const env = params.env ?? process.env;
  const updateInProgress = shouldDeferConfiguredPluginInstallRepair(env);
  const configured = collectReleaseConfiguredPluginIds({ cfg: params.cfg, env });
  const shouldRunReleaseStep = shouldRunConfiguredPluginInstallReleaseStep({
    currentVersion: params.currentVersion,
    touchedVersion: params.touchedVersion,
  });
  if (!shouldRunReleaseStep) {
    if (configured.pluginIds.length === 0 && configured.channelIds.length === 0) {
      return { changes: [], warnings: [], completed: false, touchedConfig: false };
    }
    const repaired = await repairMissingPluginInstallsForIds({
      cfg: params.cfg,
      pluginIds: configured.pluginIds,
      channelIds: configured.channelIds,
      blockedPluginIds: collectBlockedPluginIds(params.cfg),
      env,
    });
    const warnings = [...repaired.warnings, ...(repaired.notices ?? [])];
    const postInstallDoctorResult = createPostInstallDoctorResultForDeferredRepair({
      updateInProgress,
      details: repaired.deferredRepairDetails ?? [],
      warnings: repaired.warnings,
    });
    return {
      changes: repaired.changes,
      warnings,
      completed: repaired.warnings.length === 0,
      touchedConfig: false,
      ...(postInstallDoctorResult ? { postInstallDoctorResult } : {}),
    };
  }
  if (configured.pluginIds.length === 0 && configured.channelIds.length === 0) {
    return { changes: [], warnings: [], completed: true, touchedConfig: !updateInProgress };
  }
  const repaired = await repairMissingPluginInstallsForIds({
    cfg: params.cfg,
    pluginIds: configured.pluginIds,
    channelIds: configured.channelIds,
    blockedPluginIds: collectBlockedPluginIds(params.cfg),
    env,
  });
  const completed = repaired.warnings.length === 0 && !updateInProgress;
  const warnings = [...repaired.warnings, ...(repaired.notices ?? [])];
  const postInstallDoctorResult = createPostInstallDoctorResultForDeferredRepair({
    updateInProgress,
    details: repaired.deferredRepairDetails ?? [],
    warnings: repaired.warnings,
  });
  return {
    changes: repaired.changes,
    warnings,
    completed,
    touchedConfig: completed,
    ...(postInstallDoctorResult ? { postInstallDoctorResult } : {}),
  };
}

function createPostInstallDoctorResultForDeferredRepair(params: {
  updateInProgress: boolean;
  details: readonly string[];
  warnings: readonly string[];
}): UpdatePostInstallDoctorResult | undefined {
  if (!params.updateInProgress || params.warnings.length > 0 || params.details.length === 0) {
    return undefined;
  }
  return createDeferredConfiguredPluginRepairDoctorResult(params.details);
}
