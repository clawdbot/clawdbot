// Config snapshots and pre/post-update config restoration.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { createPreUpdateConfigSnapshot } from "../../config/backup-rotation.js";
import {
  mutateConfigFileWithRetry,
  parseConfigJson5,
  readConfigFileSnapshot,
} from "../../config/config.js";
import { resolveConfigEnvVars } from "../../config/env-substitution.js";
import { resolveConfigIncludes } from "../../config/includes.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { CONFIG_PATH, resolveIncludeRoots } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { normalizeUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import type { PreUpdateConfigRestoreInput } from "../../infra/update-post-core-context.js";
import { defaultRuntime } from "../../runtime.js";

const PRE_UPDATE_CONFIG_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export async function createUpdateConfigSnapshot(): Promise<void> {
  await createPreUpdateConfigSnapshot({
    configPath: CONFIG_PATH,
    fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
  });
}

export function normalizePluginInstallRecordMap(
  value: unknown,
): Record<string, PluginInstallRecord> {
  if (!isRecord(value)) {
    return {};
  }
  const records: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (isRecord(record) && typeof record.source === "string") {
      records[pluginId] = structuredClone(record) as PluginInstallRecord;
    }
  }
  return records;
}

function normalizeChannelConfigMap(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return value;
}

function normalizeDirectAuthoredChannelConfigMap(value: unknown): Record<string, unknown> | null {
  const channels = normalizeChannelConfigMap(value);
  if (!channels || Object.hasOwn(channels, "$include")) {
    return null;
  }
  return channels;
}

function restorePreUpdateChannelModelOverrides(params: {
  channels: Record<string, unknown>;
  preUpdateChannels: Record<string, unknown>;
  restoredChannelIds: string[];
}): { channels: Record<string, unknown>; changed: boolean } {
  if (params.restoredChannelIds.length === 0) {
    return { channels: params.channels, changed: false };
  }
  const preUpdateModelByChannel = normalizeChannelConfigMap(
    params.preUpdateChannels.modelByChannel,
  );
  if (!preUpdateModelByChannel) {
    return { channels: params.channels, changed: false };
  }
  const currentModelByChannel = normalizeChannelConfigMap(params.channels.modelByChannel) ?? {};
  const restoredModelByChannel = structuredClone(currentModelByChannel);
  let changed = false;
  for (const [providerId, providerOverrides] of Object.entries(preUpdateModelByChannel)) {
    const preUpdateProviderOverrides = normalizeChannelConfigMap(providerOverrides);
    if (!preUpdateProviderOverrides) {
      continue;
    }
    const currentProviderOverrides =
      normalizeChannelConfigMap(restoredModelByChannel[providerId]) ?? {};
    let providerChanged = false;
    for (const channelId of params.restoredChannelIds) {
      if (
        currentProviderOverrides[channelId] !== undefined ||
        preUpdateProviderOverrides[channelId] === undefined
      ) {
        continue;
      }
      currentProviderOverrides[channelId] = structuredClone(preUpdateProviderOverrides[channelId]);
      providerChanged = true;
    }
    if (providerChanged) {
      restoredModelByChannel[providerId] = currentProviderOverrides;
      changed = true;
    }
  }
  return changed
    ? { channels: { ...params.channels, modelByChannel: restoredModelByChannel }, changed: true }
    : { channels: params.channels, changed: false };
}

export function restoreDroppedPreUpdateChannels(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  preUpdateConfig: PreUpdateConfigRestoreInput | undefined,
): {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  changed: boolean;
  authoredChannels?: unknown;
} {
  if (!snapshot.valid || !preUpdateConfig) {
    return { snapshot, changed: false };
  }
  const preUpdateChannels = normalizeChannelConfigMap(preUpdateConfig.sourceConfig.channels);
  if (!preUpdateChannels) {
    return { snapshot, changed: false };
  }

  const postUpdateChannels = normalizeChannelConfigMap(snapshot.sourceConfig.channels) ?? {};
  let restoredChannels = { ...postUpdateChannels };
  const restoredChannelIds: string[] = [];
  let restored = false;
  for (const [channelId, channelConfig] of Object.entries(preUpdateChannels)) {
    if (restoredChannels[channelId] !== undefined) {
      continue;
    }
    restoredChannels[channelId] = structuredClone(channelConfig);
    if (channelId !== "modelByChannel") {
      restoredChannelIds.push(channelId);
    }
    restored = true;
  }
  if (!restored) {
    return { snapshot, changed: false };
  }
  const restoredModelOverrides = restorePreUpdateChannelModelOverrides({
    channels: restoredChannels,
    preUpdateChannels,
    restoredChannelIds,
  });
  restoredChannels = restoredModelOverrides.channels;

  const authoredChannels = resolveRestoredAuthoredChannels({
    currentChannels: snapshot.sourceConfig.channels,
    currentAuthoredChannels: isRecord(snapshot.parsed)
      ? (snapshot.parsed as OpenClawConfig).channels
      : snapshot.sourceConfig.channels,
    preUpdateAuthoredChannels: preUpdateConfig.authoredConfig.channels,
    restoredChannelIds,
  });
  const nextConfig = {
    ...snapshot.sourceConfig,
    channels: restoredChannels,
  } as OpenClawConfig;
  return {
    snapshot: {
      ...createUpdatedConfigSnapshot(snapshot, nextConfig),
      hash: snapshot.hash,
    },
    changed: true,
    ...(authoredChannels !== undefined ? { authoredChannels } : {}),
  };
}

function hasRestorablePreUpdateChannels(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  preUpdateConfig: PreUpdateConfigRestoreInput,
): boolean {
  if (!snapshot.valid) {
    return false;
  }
  const preUpdateChannels = normalizeChannelConfigMap(preUpdateConfig.sourceConfig.channels);
  if (!preUpdateChannels) {
    return false;
  }
  const postUpdateChannels = normalizeChannelConfigMap(snapshot.sourceConfig.channels) ?? {};
  return Object.keys(preUpdateChannels).some(
    (channelId) => postUpdateChannels[channelId] === undefined,
  );
}

function resolveRestoredAuthoredChannels(params: {
  currentChannels: unknown;
  currentAuthoredChannels: unknown;
  preUpdateAuthoredChannels: unknown;
  restoredChannelIds: string[];
}): unknown {
  if (params.preUpdateAuthoredChannels === undefined) {
    return undefined;
  }
  const directAuthoredChannels = normalizeDirectAuthoredChannelConfigMap(
    params.preUpdateAuthoredChannels,
  );
  if (!directAuthoredChannels) {
    const preUpdateAuthoredChannels = normalizeChannelConfigMap(params.preUpdateAuthoredChannels);
    if (!preUpdateAuthoredChannels) {
      return undefined;
    }
    const currentDirectAuthoredChannels = normalizeDirectAuthoredChannelConfigMap(
      params.currentAuthoredChannels,
    );
    if (currentDirectAuthoredChannels) {
      return {
        ...structuredClone(preUpdateAuthoredChannels),
        ...structuredClone(currentDirectAuthoredChannels),
      };
    }
    const currentAuthoredChannels = normalizeChannelConfigMap(params.currentAuthoredChannels);
    return !currentAuthoredChannels || Object.keys(currentAuthoredChannels).length === 0
      ? structuredClone(preUpdateAuthoredChannels)
      : undefined;
  }

  const currentChannels =
    normalizeDirectAuthoredChannelConfigMap(params.currentAuthoredChannels) ??
    normalizeDirectAuthoredChannelConfigMap(params.currentChannels) ??
    {};
  const restoredChannels = { ...currentChannels };
  let changed = false;
  for (const channelId of params.restoredChannelIds) {
    if (
      restoredChannels[channelId] !== undefined ||
      directAuthoredChannels[channelId] === undefined
    ) {
      continue;
    }
    restoredChannels[channelId] = structuredClone(directAuthoredChannels[channelId]);
    changed = true;
  }
  const restoredModelOverrides = restorePreUpdateChannelModelOverrides({
    channels: restoredChannels,
    preUpdateChannels: directAuthoredChannels,
    restoredChannelIds: params.restoredChannelIds,
  });
  if (restoredModelOverrides.changed) {
    return restoredModelOverrides.channels;
  }
  return changed ? restoredChannels : undefined;
}

export async function persistRequestedUpdateChannel(params: {
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  requestedChannel: UpdateChannel | null;
}): Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> {
  if (!params.requestedChannel || !params.configSnapshot.valid) {
    return params.configSnapshot;
  }
  const storedChannel = normalizeUpdateChannel(params.configSnapshot.config.update?.channel);
  if (params.requestedChannel === storedChannel) {
    return params.configSnapshot;
  }
  const requestedChannel = params.requestedChannel;

  const mutation = await mutateConfigFileWithRetry({
    writeOptions: { skipPluginValidation: true },
    mutate: (draft) => {
      draft.update = {
        ...draft.update,
        channel: requestedChannel,
      };
    },
  });
  return createUpdatedConfigSnapshot(mutation.snapshot, mutation.nextConfig);
}

function createUpdatedConfigSnapshot(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  next: OpenClawConfig,
): Awaited<ReturnType<typeof readConfigFileSnapshot>> {
  if (!snapshot.valid) {
    return snapshot;
  }
  return {
    ...snapshot,
    hash: undefined,
    parsed: next,
    sourceConfig: asResolvedSourceConfig(next),
    resolved: asResolvedSourceConfig(next),
    runtimeConfig: asRuntimeConfig(next),
    config: asRuntimeConfig(next),
  };
}

export async function maybeRepairLegacyConfigForUpdateChannel(params: {
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  jsonMode: boolean;
}): Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> {
  if (params.configSnapshot.valid || params.configSnapshot.legacyIssues.length === 0) {
    return params.configSnapshot;
  }

  const { repairLegacyConfigForUpdateChannel } =
    await import("../../commands/doctor/legacy-config-repair.js");
  const { snapshot, repaired } = await repairLegacyConfigForUpdateChannel(params);
  if (!params.jsonMode && repaired) {
    defaultRuntime.log(theme.muted("Migrated legacy config before changing update channel."));
  }
  return snapshot;
}

export async function writePostCoreSourceConfigFile(
  filePath: string,
  preUpdateConfig: PreUpdateConfigRestoreInput | undefined,
): Promise<void> {
  if (!preUpdateConfig) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(preUpdateConfig)}\n`, "utf-8");
}

async function readPostCoreSourceConfigFile(
  filePath: string | undefined,
  options?: { configPath?: string },
): Promise<PreUpdateConfigRestoreInput | undefined> {
  if (!filePath) {
    return undefined;
  }
  try {
    const parsed = parseConfigJson5(await fs.readFile(filePath, "utf-8"));
    if (!parsed.ok || !isRecord(parsed.parsed)) {
      return undefined;
    }
    return normalizePreUpdateConfigRestoreInput(parsed.parsed, options);
  } catch {
    return undefined;
  }
}

function normalizePreUpdateConfigRestoreInput(
  parsed: Record<string, unknown>,
  options?: { configPath?: string },
): PreUpdateConfigRestoreInput | undefined {
  const sourceConfig = parsed.sourceConfig;
  const authoredConfig = parsed.authoredConfig;
  if (isRecord(sourceConfig) && isRecord(authoredConfig)) {
    return {
      sourceConfig: sourceConfig as OpenClawConfig,
      authoredConfig: authoredConfig as OpenClawConfig,
    };
  }
  const authored = parsed as OpenClawConfig;
  return {
    sourceConfig: options?.configPath
      ? resolvePreUpdateSourceConfigFromAuthored(authored, options.configPath)
      : authored,
    authoredConfig: authored,
  };
}

function resolvePreUpdateSourceConfigFromAuthored(
  authoredConfig: OpenClawConfig,
  configPath: string,
): OpenClawConfig {
  try {
    const withIncludes = resolveConfigIncludes(authoredConfig, configPath, undefined, {
      allowedRoots: resolveIncludeRoots(process.env),
    });
    const resolved = resolveConfigEnvVars(withIncludes, process.env, {
      onMissing: () => undefined,
    });
    return isRecord(resolved) ? (resolved as OpenClawConfig) : authoredConfig;
  } catch {
    return authoredConfig;
  }
}

async function isFreshPreUpdateConfigSnapshot(params: {
  currentConfigPath: string;
  snapshotPath: string;
  updateStartedAtMs?: number;
}): Promise<boolean> {
  const snapshotStat = await fs.stat(params.snapshotPath).catch(() => null);
  if (!snapshotStat) {
    return false;
  }
  if (
    params.updateStartedAtMs !== undefined &&
    snapshotStat.mtimeMs + 1000 < params.updateStartedAtMs
  ) {
    return false;
  }
  if (Date.now() - snapshotStat.mtimeMs > PRE_UPDATE_CONFIG_SNAPSHOT_MAX_AGE_MS) {
    return false;
  }
  const currentStat = await fs.stat(params.currentConfigPath).catch(() => null);
  return !currentStat || snapshotStat.mtimeMs <= currentStat.mtimeMs + 1000;
}

export async function readPostCorePreUpdateSourceConfig(params: {
  sourceConfigPath: string | undefined;
  currentSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  updateStartedAtMs?: number;
}): Promise<PreUpdateConfigRestoreInput | undefined> {
  const fromChildEnv = await readPostCoreSourceConfigFile(params.sourceConfigPath);
  if (fromChildEnv) {
    return fromChildEnv;
  }
  if (params.updateStartedAtMs === undefined) {
    return undefined;
  }
  const explicitPreUpdatePath = `${params.currentSnapshot.path}.pre-update`;
  if (
    await isFreshPreUpdateConfigSnapshot({
      currentConfigPath: params.currentSnapshot.path,
      snapshotPath: explicitPreUpdatePath,
      updateStartedAtMs: params.updateStartedAtMs,
    })
  ) {
    const preUpdateConfig = await readPostCoreSourceConfigFile(explicitPreUpdatePath, {
      configPath: params.currentSnapshot.path,
    });
    if (
      preUpdateConfig &&
      hasRestorablePreUpdateChannels(params.currentSnapshot, preUpdateConfig)
    ) {
      return preUpdateConfig;
    }
    return undefined;
  }

  const backupPath = `${params.currentSnapshot.path}.bak`;
  if (
    await isFreshPreUpdateConfigSnapshot({
      currentConfigPath: params.currentSnapshot.path,
      snapshotPath: backupPath,
      updateStartedAtMs: params.updateStartedAtMs,
    })
  ) {
    const preUpdateConfig = await readPostCoreSourceConfigFile(backupPath, {
      configPath: params.currentSnapshot.path,
    });
    if (
      preUpdateConfig &&
      hasRestorablePreUpdateChannels(params.currentSnapshot, preUpdateConfig)
    ) {
      return preUpdateConfig;
    }
  }
  return undefined;
}
