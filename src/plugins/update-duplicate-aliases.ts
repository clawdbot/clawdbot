import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { readInstalledPackageManifest } from "../infra/package-update-utils.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginInstallDir } from "./install.js";
import type { PackageManifest } from "./manifest.js";
import { isTrustedOfficialCatalogLookupDuplicate } from "./official-external-install-records.js";
import { hasRunnableInstalledNpmPayload, migratePluginConfigId } from "./update-config.js";
import type { PluginUpdateOutcome } from "./update-source.js";

export function stageDuplicateNpmPluginAlias(params: {
  pluginId: string;
  replacementPluginId?: string;
  installs: Record<string, PluginInstallRecord>;
  aliases: Map<string, string>;
  targets: Set<string>;
  skipIds?: ReadonlySet<string>;
  outcomes: PluginUpdateOutcome[];
}): boolean {
  const replacementPluginId = params.replacementPluginId;
  if (
    !replacementPluginId ||
    replacementPluginId === params.pluginId ||
    !Object.hasOwn(params.installs, replacementPluginId)
  ) {
    return false;
  }
  if (
    isTrustedOfficialCatalogLookupDuplicate({
      pluginId: params.pluginId,
      replacementPluginId,
      replacementRecord: params.installs[replacementPluginId],
    })
  ) {
    // Keep the working alias authoritative until the canonical payload has
    // passed this update flow. A failed replacement must not persist removal.
    params.aliases.set(params.pluginId, replacementPluginId);
    if (!params.skipIds?.has(replacementPluginId)) {
      params.targets.add(replacementPluginId);
    }
  } else {
    params.outcomes.push({
      pluginId: params.pluginId,
      status: "error",
      message: `Cannot replace "${params.pluginId}" with "${replacementPluginId}" because both plugin install records exist. Remove one of the conflicting installs, then retry the update.`,
    });
  }
  return true;
}

async function hasRunnableRecordedPayload(
  config: OpenClawConfig,
  pluginId: string,
): Promise<boolean> {
  const record = config.plugins?.installs?.[pluginId];
  if (!record) {
    return false;
  }
  try {
    const installPath = resolveUserPath(
      record.installPath?.trim() || resolvePluginInstallDir(pluginId),
    );
    // SAFETY: the JSON reader returns a record; extension resolution validates its fields.
    const manifest = readInstalledPackageManifest(installPath) as PackageManifest | undefined;
    return await hasRunnableInstalledNpmPayload({ installPath, manifest });
  } catch {
    return false;
  }
}

export async function reconcileDuplicateNpmPluginAliases(params: {
  config: OpenClawConfig;
  aliases: ReadonlyMap<string, string>;
  completedCanonicalUpdates: ReadonlySet<string>;
  skipIds?: ReadonlySet<string>;
  dryRun?: boolean;
  outcomes: PluginUpdateOutcome[];
  installOwnerMigrations: Record<string, string>;
}): Promise<{ config: OpenClawConfig; changed: boolean }> {
  let config = params.config;
  let changed = false;
  for (const [aliasPluginId, canonicalPluginId] of params.aliases) {
    const completed =
      params.completedCanonicalUpdates.has(canonicalPluginId) ||
      params.skipIds?.has(canonicalPluginId);
    if (
      !completed ||
      (!params.dryRun && !(await hasRunnableRecordedPayload(config, canonicalPluginId)))
    ) {
      params.outcomes.push({
        pluginId: aliasPluginId,
        status: "skipped",
        message: `Kept duplicate "${aliasPluginId}" install record because "${canonicalPluginId}" did not complete a runnable canonical update.`,
      });
      continue;
    }
    if (!params.dryRun) {
      config = migratePluginConfigId(config, aliasPluginId, canonicalPluginId);
      changed = true;
      params.installOwnerMigrations[aliasPluginId] = canonicalPluginId;
    }
    params.outcomes.push({
      pluginId: aliasPluginId,
      status: "skipped",
      message: `${params.dryRun ? "Would remove" : "Removed"} duplicate "${aliasPluginId}" install record; "${canonicalPluginId}" is the canonical plugin id.`,
    });
  }
  return { config, changed };
}
