/** Builds doctor/install repair hints for missing official external plugin owners. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredChannelPresencePolicy } from "./channel-plugin-ids.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstallSources,
  resolveOfficialExternalPluginLabel,
} from "./official-external-plugin-catalog.js";

/** Repair hint for installing an official external plugin that owns a missing surface. */
export type OfficialExternalPluginRepairHint = {
  pluginId: string;
  channelId?: string;
  label: string;
  installSpec: string;
  installCommand: string;
  doctorFixCommand: string;
  repairHint: string;
};

type MissingOfficialExternalChannelPluginRepairHint = OfficialExternalPluginRepairHint & {
  channelId: string;
};

/** Resolves install/doctor commands for an official external plugin or channel id. */
export function resolveOfficialExternalPluginRepairHint(
  pluginIdOrChannelId: string,
): OfficialExternalPluginRepairHint | null {
  const entry = getOfficialExternalPluginCatalogEntry(pluginIdOrChannelId);
  if (!entry) {
    return null;
  }
  const installSpec = resolveOfficialExternalPluginInstallSources(entry)[0]?.spec;
  if (!installSpec) {
    return null;
  }
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const pluginId = resolveOfficialExternalPluginId(entry) ?? pluginIdOrChannelId.trim();
  const channelId = manifest?.channel?.id?.trim();
  const label = resolveOfficialExternalPluginLabel(entry);
  const installCommand = `openclaw plugins install ${installSpec}`;
  const doctorFixCommand = "openclaw doctor --fix";
  return {
    pluginId,
    ...(channelId ? { channelId } : {}),
    label,
    installSpec,
    installCommand,
    doctorFixCommand,
    repairHint: `Install the official external plugin with: ${installCommand}, or run: ${doctorFixCommand}.`,
  };
}

type MissingOfficialExternalChannelPluginRepairHintParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Prepared manifest facts avoid rebuilding the registry for this resolution. */
  manifestRecords?: readonly PluginManifestRecord[];
};

/** Resolves repair hints for missing configured channels with one presence-policy pass. */
export function resolveMissingOfficialExternalChannelPluginRepairHints(
  params: MissingOfficialExternalChannelPluginRepairHintParams & {
    channelIds: readonly string[];
  },
): MissingOfficialExternalChannelPluginRepairHint[] {
  if (params.channelIds.length === 0) {
    return [];
  }
  const policiesByChannelId = new Map(
    resolveConfiguredChannelPresencePolicy({
      config: params.config,
      activationSourceConfig: params.activationSourceConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includePersistedAuthState: false,
      manifestRecords: params.manifestRecords,
    }).map((entry) => [entry.channelId, entry]),
  );
  return params.channelIds.flatMap((channelId) => {
    const hint = resolveOfficialExternalPluginRepairHint(channelId);
    if (!hint?.channelId || hint.channelId !== channelId) {
      return [];
    }
    const policy = policiesByChannelId.get(hint.channelId);
    return policy &&
      !policy.effective &&
      policy.blockedReasons.length === 1 &&
      policy.blockedReasons[0] === "no-channel-owner"
      ? [{ ...hint, channelId: hint.channelId }]
      : [];
  });
}

/** Resolves a repair hint only when a missing configured channel is blocked by no plugin owner. */
export function resolveMissingOfficialExternalChannelPluginRepairHint(
  params: MissingOfficialExternalChannelPluginRepairHintParams & { channelId: string },
): MissingOfficialExternalChannelPluginRepairHint | null {
  return (
    resolveMissingOfficialExternalChannelPluginRepairHints({
      config: params.config,
      activationSourceConfig: params.activationSourceConfig,
      channelIds: [params.channelId],
      workspaceDir: params.workspaceDir,
      env: params.env,
      manifestRecords: params.manifestRecords,
    })[0] ?? null
  );
}
