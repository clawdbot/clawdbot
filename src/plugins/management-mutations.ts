// Owns managed plugin install, policy and uninstall mutations under the lifecycle lease.
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentAcknowledgment,
} from "./capability-consent.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import {
  type ManagedPluginCatalogEntry,
  loadOfficialCatalog,
  resolveOfficialEntryById,
} from "./management-catalog.js";
import {
  type ManagedPluginSourceInstallRequest,
  installManagedPluginSource,
} from "./management-install.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  loadFreshManagedPluginMetadata,
  refreshManagedPluginMetadata,
  listManagedPlugins,
} from "./management-service.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";
import { collectClawPluginUninstallWarnings } from "./uninstall-claw-references.js";
import {
  prepareConfigForDisabledPluginSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  planPluginUninstall,
  pluginUninstallTargetExists,
} from "./uninstall.js";

type ManagedPluginInstallRequest =
  | {
      source: "clawhub";
      packageName: string;
      version?: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    }
  | {
      source: "official";
      pluginId: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    };

function assertValidConfigSnapshot(
  prepared: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>,
): ConfigSnapshotForInstallPersist {
  const { snapshot, writeOptions } = prepared;
  if (!snapshot.valid) {
    throw new ManagedPluginLifecycleError(
      "Config invalid; run `openclaw doctor --fix` before managing plugins.",
    );
  }
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  const { pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed: asRecord(snapshot.parsed),
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  if (pluginMutation.mode === "blocked") {
    throw new ManagedPluginLifecycleError(pluginMutation.reason);
  }
  return {
    config: snapshot.sourceConfig,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
  };
}

async function readPluginMutationSnapshot(
  env: NodeJS.ProcessEnv,
): Promise<ConfigSnapshotForInstallPersist> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env });
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
  return assertValidConfigSnapshot(await readConfigFileSnapshotForWrite());
}

function createSilentRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new ManagedPluginLifecycleError(`plugin lifecycle exited with code ${code}`);
    },
  };
}

function createInstallLogger(warnings: string[]) {
  return {
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
  };
}

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  // Bundled identities remain the local trust anchor when a hosted feed omits
  // its ClawHub candidate; hosted install/version metadata is never copied back.
  return [...listOfficialExternalPluginCatalogEntries(), ...entries].find((entry) => {
    return resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    );
  });
}

function resolveHostedOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => {
    return resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    );
  });
}

function buildClawHubSpec(packageName: string, version?: string): string {
  const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
  if (!parsed || parsed.version) {
    throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
  }
  return `clawhub:${packageName}${version ? `@${version}` : ""}`;
}

function throwInstallFailure(result: {
  error: string;
  code?: string;
  version?: string;
  warning?: string;
  installPolicyWarning?: InstallPolicyWarningDetails;
}): never {
  const unavailable =
    !result.code ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
  throw new ManagedPluginLifecycleError(result.error, {
    kind: unavailable ? "unavailable" : "invalid-request",
    code: result.code,
    version: result.version,
    warning: result.warning,
    installPolicyWarning: result.installPolicyWarning,
    cause: result,
  });
}

function resolveManagedClawHubInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "clawhub" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  expectedIntegrity?: string;
}): Extract<ManagedPluginSourceInstallRequest, { source: "clawhub" }> {
  const packageName = params.request.packageName.trim();
  const official = resolveOfficialEntryByClawHubPackage(params.officialEntries, packageName);
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs.
  const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
  const hostedOfficial = resolveHostedOfficialEntryByClawHubPackage(
    params.officialEntries,
    packageName,
  );
  const hostedSource = hostedOfficial
    ? resolveOfficialExternalPluginInstallSources(hostedOfficial).find(
        (source) => source.source === "clawhub",
      )
    : undefined;
  const hostedClawHub = parseClawHubPluginSpec(hostedSource?.spec ?? "");
  const requestMatchesHostedCandidate =
    !params.request.version || params.request.version === hostedClawHub?.version;
  const version =
    params.request.version ?? (requestMatchesHostedCandidate ? hostedClawHub?.version : undefined);
  const expectedIntegrity =
    params.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedSource?.expectedIntegrity : undefined);
  return {
    source: "clawhub",
    spec: buildClawHubSpec(packageName, version),
    ...(official ? { trustedSourceLinkedOfficialInstall: true } : {}),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
  };
}

function resolveManagedOfficialInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "official" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): ManagedPluginSourceInstallRequest {
  const entry = resolveOfficialEntryById(params.officialEntries, params.request.pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(
      `unknown official plugin catalog entry: ${params.request.pluginId}`,
    );
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  const install = resolveOfficialExternalPluginInstall(entry);
  if (!pluginId || !install) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry is not installable: ${params.request.pluginId}`,
    );
  }
  const installSources = resolveOfficialExternalPluginInstallSources(entry);
  const primary = installSources[0];
  if (!primary) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  return {
    source: "official",
    spec: primary.spec,
    installSources,
    pluginId,
    expectedPluginId: resolveDeclaredOfficialPluginId(entry),
    mode: "install",
  };
}

/** Install a ClawHub or curated official plugin through the canonical install pipeline. */
export async function installManagedPlugin(params: {
  request: ManagedPluginInstallRequest;
  env?: NodeJS.ProcessEnv;
}): Promise<{ plugin: ManagedPluginCatalogEntry; warnings?: string[] }> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const officialCatalog = await loadOfficialCatalog();
    const warnings: string[] = [];
    const installLogger = createInstallLogger(warnings);
    const request =
      params.request.source === "clawhub"
        ? resolveManagedClawHubInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          })
        : resolveManagedOfficialInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          });
    const installed = await installManagedPluginSource({
      request,
      snapshot,
      env,
      logger: installLogger,
      ...(params.request.acknowledgeCapabilities
        ? { acknowledgeCapabilities: params.request.acknowledgeCapabilities }
        : {}),
      ...(params.request.acknowledgeInstallPolicyWarning
        ? {
            safetyOverrides: {
              onInstallPolicyWarning: async () => ({ status: "approved" as const }),
            },
          }
        : {}),
      invalidateRuntimeCache: false,
      runtime: createSilentRuntime(),
    });
    if (!installed.ok) {
      return throwInstallFailure(installed);
    }
    warnings.push(...(installed.warnings ?? []));
    const workspace = resolvePluginControlPlaneWorkspace({ config: installed.config, env });
    if (workspace.diagnostic && !getProcessGatewayPluginMetadataSnapshot()) {
      warnings.push(workspace.diagnostic.message);
    }
    // Management inspects the committed candidate; the Gateway keeps its boot inventory.
    const installedMetadata = refreshManagedPluginMetadata({ config: installed.config, env });
    const catalog = await listManagedPlugins({
      config: installed.config,
      env,
      officialCatalog,
      metadata: installedMetadata,
    });
    const installedOwnership = createInstalledPluginOwnershipResolver(
      installedMetadata.index,
      env,
    ).resolvePackage(installed.pluginId);
    if (!installedOwnership.ok) {
      throw new ManagedPluginLifecycleError(installedOwnership.error);
    }
    const installedPluginIds = installedOwnership.value.pluginIds;
    const representativePluginId = installedPluginIds[0]!;
    const plugin = catalog.plugins.find((entry) => entry.id === representativePluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `installed plugin missing from refreshed registry: ${installed.pluginId}`,
      );
    }
    return {
      plugin,
      ...(installedPluginIds.length > 1 || warnings.length > 0
        ? {
            warnings: [
              ...(installedPluginIds.length > 1
                ? [
                    `Installed package "${installed.pluginId}" with plugin entries: ${installedPluginIds.join(", ")}.`,
                  ]
                : []),
              ...new Set(warnings),
            ],
          }
        : {}),
    };
  });
}

/** Persist desired plugin policy while preserving allow/deny, slot, include, and hash guards. */
export async function setManagedPluginEnabled(params: {
  pluginId: string;
  enabled: boolean;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
}> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const metadata = loadFreshManagedPluginMetadata(snapshot.config, env);
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const installedPlugin = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!installedPlugin) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    if (params.enabled && !installedPlugin.enabled) {
      await resolvePluginCapabilityConsent({
        config: snapshot.config,
        env,
        pluginId,
        acknowledge: params.acknowledgeCapabilities,
        metadata,
      });
    }
    let next = snapshot.config;
    const warnings: string[] = [];
    let policyPluginId = pluginId;
    if (params.enabled) {
      // The admin-scoped enable RPC is an explicit trust action. Preserve the
      // existing inventory while admitting only the selected installed plugin.
      if ((next.plugins?.allow?.length ?? 0) > 0) {
        next = ensurePluginAllowlisted(next, pluginId);
      }
      const enableResult = enableExplicitlySelectedPluginInConfig(next, pluginId, {
        updateChannelConfig: false,
      });
      if (!enableResult.enabled) {
        throw new ManagedPluginLifecycleError(
          `plugin "${pluginId}" could not be enabled (${enableResult.reason ?? "unknown reason"})`,
        );
      }
      next = enableResult.config;
      policyPluginId = enableResult.pluginId;
      const slotResult = applySlotSelectionForPlugin(next, pluginId, metadata);
      next = slotResult.config;
      warnings.push(...slotResult.warnings);
    } else {
      next = setPluginEnabledInConfig(next, pluginId, false, { updateChannelConfig: false });
    }
    const changedPaths = new Set<string>();
    collectChangedPaths(snapshot.config, next, "", changedPaths);
    await replaceConfigFile({
      nextConfig: next,
      baseHash: snapshot.baseHash,
      writeOptions: snapshot.writeOptions,
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: next,
      env,
      reason: "policy-changed",
      invalidateRuntimeCache: false,
      policyPluginIds: [policyPluginId],
      logger: { warn: (message) => warnings.push(message) },
    });
    const updatedMetadata = refreshManagedPluginMetadata({ config: next, env });
    const catalog = await listManagedPlugins({ config: next, env, metadata: updatedMetadata });
    const plugin = catalog.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `updated plugin missing from refreshed registry: ${pluginId}`,
      );
    }
    return {
      plugin,
      changedPaths: [...changedPaths].filter(Boolean).toSorted(),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

/** Remove an installed plugin: config references, install record, and managed files. */
export async function uninstallManagedPlugin(params: {
  pluginId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pluginId: string; removed: string[]; warnings?: string[] }> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const installRecords = await loadInstalledPluginIndexInstallRecords({ env });
    // Mirror the CLI uninstall flow: plan against config carrying install records
    // so managed npm/git directories resolve, then persist the stripped config.
    const configWithRecords = withPluginInstallRecords(snapshot.config, installRecords);
    const metadata = loadFreshManagedPluginMetadata(configWithRecords, env);
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const record = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (record?.origin === "bundled") {
      throw new ManagedPluginLifecycleError(
        `bundled plugin cannot be uninstalled: ${pluginId}; disable it instead`,
      );
    }
    if (!record && !Object.hasOwn(installRecords, pluginId)) {
      throw new ManagedPluginLifecycleError(`Plugin not found: ${pluginId}`);
    }
    const ownership = createInstalledPluginOwnershipResolver(metadata.index, env).resolveLifecycle(
      pluginId,
    );
    if (!ownership.ok) {
      throw new ManagedPluginLifecycleError(ownership.error);
    }
    const { installOwner, pluginIds: ownedPluginIds } = ownership.value;
    const policyPluginIds = ownedPluginIds.length > 0 ? ownedPluginIds : [installOwner];
    const ownedManifests = ownedPluginIds.flatMap((entryId) => {
      const manifest = metadata.byPluginId.get(entryId);
      return manifest ? [manifest] : [];
    });
    const channelIds =
      ownedManifests.length > 0
        ? uniqueStrings(ownedManifests.flatMap((manifest) => manifest.channels))
        : ownership.value.kind === "orphan" &&
            createInstalledPluginIndexScopeLookup(metadata.index).hasChannelContributionOwners([
              installOwner,
            ])
          ? []
          : undefined;
    const extensionsDir = resolveDefaultPluginExtensionsDir(env);
    const initialPlan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: configWithRecords,
          pluginId: installOwner,
          ...(channelIds !== undefined ? { channelIds } : {}),
          deleteFiles: true,
          extensionsDir,
        },
        {
          runtimePluginIds: policyPluginIds,
          runtimeLoadPaths: ownedPluginIds.flatMap(
            (entryId) => metadata.byPluginId.get(entryId)?.source ?? [],
          ),
        },
      ),
    );
    if (!initialPlan.ok) {
      throw new ManagedPluginLifecycleError(initialPlan.error);
    }
    let plan = initialPlan;
    let finalSnapshot = snapshot;
    let directoryResult: Awaited<ReturnType<typeof applyPluginUninstallDirectoryRemoval>> = {
      directoryRemoved: false,
      warnings: [],
    };
    if (plan.directoryRemoval) {
      const disabledConfig = prepareConfigForDisabledPluginSet(snapshot.config, policyPluginIds);
      await replaceConfigFile({
        nextConfig: disabledConfig,
        baseHash: snapshot.baseHash,
        writeOptions: {
          ...snapshot.writeOptions,
          afterWrite: { mode: "auto" },
        },
      });
      directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
      if (pluginUninstallTargetExists(plan.directoryRemoval.target)) {
        throw new ManagedPluginLifecycleError(
          `Failed to remove plugin directory ${plan.directoryRemoval.target}; the plugin remains disabled and tracked so uninstall can be retried.`,
          { kind: "unavailable" },
        );
      }
      finalSnapshot = await readPluginMutationSnapshot(env);
      const refreshedConfigWithRecords = withPluginInstallRecords(
        finalSnapshot.config,
        installRecords,
      );
      const refreshedPlan = planPluginUninstall(
        recordPluginPackageUninstallPlan(
          {
            config: refreshedConfigWithRecords,
            pluginId: installOwner,
            ...(channelIds !== undefined ? { channelIds } : {}),
            deleteFiles: true,
            extensionsDir,
          },
          {
            runtimePluginIds: policyPluginIds,
            runtimeLoadPaths: ownedPluginIds.flatMap(
              (entryId) => metadata.byPluginId.get(entryId)?.source ?? [],
            ),
          },
        ),
      );
      if (!refreshedPlan.ok) {
        throw new ManagedPluginLifecycleError(refreshedPlan.error);
      }
      plan = refreshedPlan;
    }
    const nextConfig = withoutPluginInstallRecords(plan.config);
    const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, installOwner);
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: installRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: finalSnapshot.baseHash,
      writeOptions: finalSnapshot.writeOptions,
    });
    const warnings = [
      ...collectClawPluginUninstallWarnings({
        pluginId: installOwner,
        installRecord: installRecords[installOwner],
        env,
      }),
      ...(pluginId !== installOwner || ownedPluginIds.length > 1
        ? [
            `Uninstalled package "${installOwner}" and all owned plugin entries: ${ownedPluginIds.join(", ")}.`,
          ]
        : []),
      ...directoryResult.warnings,
    ];
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      env,
      reason: "source-changed",
      installRecords: nextInstallRecords,
      invalidateRuntimeCache: false,
      logger: { warn: (message) => warnings.push(message) },
    });
    refreshManagedPluginMetadata({ config: nextConfig, env });
    const removed = formatUninstallActionLabels({
      ...plan.actions,
      directory: directoryResult.directoryRemoved,
    });
    return {
      pluginId: installOwner,
      removed,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  });
}
