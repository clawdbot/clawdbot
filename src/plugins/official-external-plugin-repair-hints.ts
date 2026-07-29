/** Builds doctor/install repair hints for missing official external plugin owners. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredChannelPresencePolicy } from "./channel-plugin-ids.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
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

/** Resolves install/doctor commands for an official external plugin or channel id. */
export function resolveOfficialExternalPluginRepairHint(
  pluginIdOrChannelId: string,
): OfficialExternalPluginRepairHint | null {
  const entry = getOfficialExternalPluginCatalogEntry(pluginIdOrChannelId);
  if (!entry) {
    return null;
  }
  const install = resolveOfficialExternalPluginInstall(entry);
  const npmSpec = install?.npmSpec?.trim();
  const clawhubSpec = install?.clawhubSpec?.trim();
  const installSpec =
    install?.defaultChoice === "clawhub" ? (clawhubSpec ?? npmSpec) : (npmSpec ?? clawhubSpec);
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

/** Resolves a repair hint only when a missing configured channel is blocked by no plugin owner. */
export function resolveMissingOfficialExternalChannelPluginRepairHint(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelId: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): OfficialExternalPluginRepairHint | null {
  const hint = resolveOfficialExternalPluginRepairHint(params.channelId);
  if (!hint?.channelId || hint.channelId !== params.channelId) {
    return null;
  }
  const policy = resolveConfiguredChannelPresencePolicy({
    config: params.config,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includePersistedAuthState: false,
  }).find((entry) => entry.channelId === hint.channelId);
  if (!policy || policy.effective) {
    return null;
  }
  return policy.blockedReasons.length === 1 && policy.blockedReasons[0] === "no-channel-owner"
    ? hint
    : null;
}
