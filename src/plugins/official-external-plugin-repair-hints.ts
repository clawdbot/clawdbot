/** Builds doctor/install repair hints for missing official external plugin owners. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredChannelPresencePolicy } from "./channel-plugin-ids.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogManifest,
  isExternallyDistributedPlugin,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstallSources,
  resolveOfficialExternalPluginLabel,
  type OfficialExternalPluginCatalogEntry,
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

/**
 * Bundled plugins ship their dependencies inside the root package, so dependency status is
 * only meaningful for external installs and for externally distributed plugins whose runtime
 * was compiled into the bundled tree without its plugin-local dependencies.
 */
export function tracksPluginDependencyStatus(candidate: {
  origin: string;
  pluginId: string;
  packageName?: string;
  packageBuild?: { bundledDist?: boolean };
}): boolean {
  return candidate.origin !== "bundled" || isExternallyDistributedPlugin(candidate);
}

/**
 * Names the install path when an externally distributed plugin fails to import its runtime
 * dependencies. Source builds compile these plugins into `dist/extensions/<id>` but their
 * dependencies stay plugin-local, so a moved or pruned checkout leaves the dist link dangling.
 */
export function resolveExternalPluginRuntimeDependencyRepairHint(candidate: {
  pluginId: string;
  packageName?: string;
  packageBuild?: { bundledDist?: boolean };
}): string | undefined {
  if (!isExternallyDistributedPlugin(candidate)) {
    return undefined;
  }
  // Only the official package that owns this canonical id earns its install command; a foreign
  // package reusing the id must not be told to install the official one over itself.
  const entry = getOfficialExternalPluginCatalogEntryForPackage(candidate.packageName);
  const hint =
    entry && resolveOfficialExternalPluginId(entry) === candidate.pluginId
      ? buildOfficialExternalPluginRepairHint(entry, candidate.pluginId)
      : null;
  return hint
    ? `runtime dependencies are missing for externally distributed plugin ${hint.label}; ${hint.repairHint}`
    : `runtime dependencies are missing for externally distributed plugin ${candidate.pluginId}; reinstall or update the plugin package, then restart the Gateway.`;
}

/** Resolves install/doctor commands for an official external plugin or channel id. */
export function resolveOfficialExternalPluginRepairHint(
  pluginIdOrChannelId: string,
): OfficialExternalPluginRepairHint | null {
  const entry = getOfficialExternalPluginCatalogEntry(pluginIdOrChannelId);
  return entry ? buildOfficialExternalPluginRepairHint(entry, pluginIdOrChannelId) : null;
}

function buildOfficialExternalPluginRepairHint(
  entry: OfficialExternalPluginCatalogEntry,
  pluginIdOrChannelId: string,
): OfficialExternalPluginRepairHint | null {
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
