import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../../../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import { expectedIntegrityForUpdate } from "../../../infra/package-update-utils.js";
import type { UpdateChannel } from "../../../infra/update-channels.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "../../../plugins/config-state.js";
import {
  resolvePluginInstallSources,
  type resolveNpmInstallSpecsForUpdateChannel,
} from "../../../plugins/install-channel-specs.js";
import { resolveTrustedSourceLinkedOfficialNpmInstall } from "../../../plugins/official-external-install-records.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../../../plugins/official-external-plugin-catalog.js";
import { isPayloadMissing } from "../../../plugins/payload-verification.js";
import { resolveNpmUpdateTarget } from "../../../plugins/update-source.js";
import {
  collectDownloadableInstallCandidates,
  resolveConfiguredPluginInstallContext,
  type DownloadableInstallCandidate,
} from "./missing-configured-plugin-install.candidates.js";
import {
  collectBlockedPluginIds,
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
} from "./missing-configured-plugin-install.ids.js";
import { isTrustedOfficialInstallRecordForCandidate } from "./missing-configured-plugin-install.records.js";

export type InstallCandidateRepairReason = "stale-version-bound-runtime";
type InstallContext = Awaited<ReturnType<typeof resolveConfiguredPluginInstallContext>>;

export function resolveRecordedInstallCandidate(params: {
  candidate: DownloadableInstallCandidate;
  record?: PluginInstallRecord;
  repairReason?: InstallCandidateRepairReason;
}): DownloadableInstallCandidate {
  const record = params.record;
  if (!record && params.candidate.trustedSourceLinkedOfficialInstall) {
    const packageName = parseRegistryNpmSpec(params.candidate.npmSpec ?? "")?.name;
    const officialReleasePackage =
      packageName?.startsWith("@openclaw/") &&
      listOfficialExternalPluginCatalogEntries().some(
        (entry) =>
          entry.source === "official" &&
          entry.name === packageName &&
          resolveOfficialExternalPluginId(entry) === params.candidate.pluginId &&
          parseRegistryNpmSpec(resolveOfficialExternalPluginInstall(entry)?.npmSpec ?? "")?.name ===
            packageName,
      );
    if (officialReleasePackage) {
      // Formerly bundled plugins have no recorded selector; restore the core's release cohort.
      return { ...params.candidate, versionBoundToOpenClaw: true };
    }
  }
  const recordedSource =
    record?.source === "npm" || record?.source === "clawhub" ? record.source : undefined;
  const staleRuntimeRepair = params.repairReason === "stale-version-bound-runtime";
  const declaredSource = recordedSource
    ? resolvePluginInstallSources(params.candidate, recordedSource)[0]
    : undefined;
  // Only the admitted cohort repair replaces a recorded target. Its new artifact
  // uses the declared source's integrity; ordinary payload repair retains both pins.
  const recordedSpec = staleRuntimeRepair
    ? declaredSource?.spec
    : (record?.spec ?? declaredSource?.spec);
  return record && recordedSource
    ? {
        ...params.candidate,
        defaultChoice: recordedSource,
        ...(recordedSource === "npm"
          ? { npmSpec: recordedSpec, clawhubSpec: undefined }
          : { clawhubSpec: recordedSpec, npmSpec: undefined }),
        expectedIntegrity: staleRuntimeRepair
          ? declaredSource?.expectedIntegrity
          : expectedIntegrityForUpdate(record.spec, record.integrity),
        trustedSourceLinkedOfficialInstall:
          params.candidate.trustedSourceLinkedOfficialInstall &&
          (!record.spec ||
            (recordedSource === "npm"
              ? parseRegistryNpmSpec(record.spec)?.name ===
                parseRegistryNpmSpec(params.candidate.npmSpec ?? "")?.name
              : parseClawHubPluginSpec(record.spec)?.name ===
                parseClawHubPluginSpec(params.candidate.clawhubSpec ?? "")?.name)),
      }
    : params.candidate;
}

/** Keep stale-runtime pin replacement behind the same repair admission as doctor. */
export function resolveConfiguredPluginCandidateRepair(params: {
  candidate: DownloadableInstallCandidate;
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
  context: Pick<
    InstallContext,
    | "bundledPluginsById"
    | "officialReplacementPluginIds"
    | "knownIds"
    | "installedPluginIdsWithStaleVersionBoundRuntimePackages"
    | "installedPluginIdsWithRepairablePackageDiagnostics"
    | "configuredPluginIdsWithStaleDescriptors"
  >;
}):
  | { shouldReplaceBrokenOfficialInstall: boolean; repairReason?: InstallCandidateRepairReason }
  | undefined {
  const { candidate, context } = params;
  if (context.bundledPluginsById.has(candidate.pluginId)) {
    return undefined;
  }
  const shouldReplaceBrokenOfficialInstall = context.officialReplacementPluginIds.has(
    candidate.pluginId,
  );
  const record = params.records[candidate.pluginId];
  if (
    shouldReplaceBrokenOfficialInstall &&
    (!candidate.trustedSourceLinkedOfficialInstall ||
      !isTrustedOfficialInstallRecordForCandidate({ record, candidate }))
  ) {
    return undefined;
  }
  const hasRecord = Object.hasOwn(params.records, candidate.pluginId);
  const hasUsableRecord = hasRecord && !isPayloadMissing(params.env, record?.installPath);
  if (
    !shouldReplaceBrokenOfficialInstall &&
    (hasUsableRecord || (context.knownIds.has(candidate.pluginId) && !hasRecord))
  ) {
    return undefined;
  }
  return {
    shouldReplaceBrokenOfficialInstall,
    ...(context.installedPluginIdsWithStaleVersionBoundRuntimePackages.has(candidate.pluginId) &&
    !context.installedPluginIdsWithRepairablePackageDiagnostics.has(candidate.pluginId) &&
    !context.configuredPluginIdsWithStaleDescriptors.has(candidate.pluginId) &&
    hasUsableRecord
      ? { repairReason: "stale-version-bound-runtime" as const }
      : {}),
  };
}

type ConfiguredNpmPluginTarget = Parameters<typeof resolveNpmInstallSpecsForUpdateChannel>[0] & {
  pluginId: string;
};

/** Metadata-only inventory for the same npm targets used by post-core sync and repair. */
export async function collectConfiguredNpmPluginTargets(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targetVersion: string;
  channel: UpdateChannel;
  installRecords?: Record<string, PluginInstallRecord>;
}): Promise<ConfiguredNpmPluginTarget[]> {
  const configuredPluginIds = collectConfiguredPluginIds(params.config, params.env);
  const configuredChannelIds = collectConfiguredChannelIds(params.config, params.env);
  if (configuredPluginIds.size === 0 && configuredChannelIds.size === 0) {
    return [];
  }
  const blockedPluginIds = collectBlockedPluginIds(params.config);
  const context = await resolveConfiguredPluginInstallContext({
    cfg: params.config,
    env: params.env,
    configuredPluginIds,
    configuredChannelIds,
    blockedPluginIds,
    baselineRecords: params.installRecords,
    coreVersion: params.targetVersion,
  });
  const candidates = new Map(
    collectDownloadableInstallCandidates({
      cfg: params.config,
      env: params.env,
      configuredPluginIds,
      configuredChannelIds,
      configuredChannelOwnerPluginIds: context.configuredChannelOwnerPluginIds,
      blockedPluginIds,
      missingPluginIds: new Set(),
    }).map((candidate) => [candidate.pluginId, candidate]),
  );
  const normalizedConfig = normalizePluginsConfig(params.config.plugins);
  const targets: ConfiguredNpmPluginTarget[] = [];
  const pluginIds = new Set([
    ...configuredPluginIds,
    ...candidates.keys(),
    ...[...context.configuredChannelOwnerPluginIds.values()].flatMap((ids) => Array.from(ids)),
  ]);
  for (const pluginId of pluginIds) {
    const record = context.records[pluginId];
    if (
      context.bundledPluginsById.has(pluginId) ||
      (record && (record.source !== "npm" || record.artifactKind || record.sourcePath)) ||
      !resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedConfig,
        rootConfig: params.config,
      }).enabled
    ) {
      continue;
    }
    const candidate = candidates.get(pluginId);
    const repair =
      candidate &&
      resolveConfiguredPluginCandidateRepair({
        candidate,
        records: context.records,
        env: params.env,
        context,
      });
    if (candidate && repair) {
      const selected = resolveRecordedInstallCandidate({
        candidate,
        record,
        repairReason: repair.repairReason,
      });
      const source = resolvePluginInstallSources(
        selected,
        record?.source === "npm" ? "npm" : undefined,
      )[0];
      if (source?.source === "npm" && parseRegistryNpmSpec(source.spec)) {
        targets.push({
          pluginId,
          spec: source.spec,
          updateChannel: params.channel,
          coreVersion: params.targetVersion,
          officialPackageName: selected.trustedSourceLinkedOfficialInstall
            ? parseRegistryNpmSpec(source.spec)?.name
            : undefined,
          versionBoundToCore: selected.versionBoundToOpenClaw,
        });
      }
    } else if (record?.source === "npm") {
      const { target } = resolveNpmUpdateTarget({
        record,
        trustedOfficialInstall: resolveTrustedSourceLinkedOfficialNpmInstall({ pluginId, record }),
        syncOfficialPluginInstalls: true,
        updateChannel: params.channel,
        coreVersion: params.targetVersion,
        versionBoundToCore: candidate?.versionBoundToOpenClaw,
      });
      if (target && parseRegistryNpmSpec(target.spec)) {
        targets.push({ pluginId, ...target });
      }
    }
  }
  return targets.toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}
