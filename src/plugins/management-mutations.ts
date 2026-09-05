// Owns managed plugin install, policy and uninstall mutations under the lifecycle lease.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { PluginsInstallParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import {
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentAcknowledgment,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import { loadConfigForInstall, PluginInstallConfigError } from "./install-config.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { resolvePluginInstallRequestContext } from "./install-request-context.js";
import { resolveManagedPluginInstallRequest } from "./install-source-plan.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import type { PluginLifecycleRuntimeApply, PluginRuntimeApplication } from "./lifecycle.js";
import { type ManagedPluginCatalogEntry, loadOfficialCatalog } from "./management-catalog.js";
import {
  installManagedPluginSource,
  resolveOfficialManagedInstallSpec,
  type ManagedPluginInstallOptions,
  type SourceInstallFailure,
} from "./management-install.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  loadFreshManagedPluginMetadata,
  refreshManagedPluginMetadata,
  listManagedPlugins,
} from "./management-service.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";
import { collectClawPluginUninstallWarnings } from "./uninstall-claw-references.js";
import {
  prepareConfigForDisabledPluginSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import { resolvePluginUninstallId } from "./uninstall-selection.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  formatUninstallSlotResetPreview,
  planPluginUninstall,
  pluginUninstallTargetExists,
  resolveUninstallChannelConfigKeys,
  UNINSTALL_ACTION_LABELS,
} from "./uninstall.js";

type ManagedPluginMutationOptions = Pick<
  ManagedPluginInstallOptions,
  "applyRuntime" | "beforePersistentApply" | "env" | "signal"
>;

function withManagedPluginMutation<T>(
  params: ManagedPluginMutationOptions,
  run: (beforePersistentApply: () => void, assertLeaseOwned: () => void) => Promise<T>,
): Promise<T> {
  return withPluginLifecycleLease(
    { env: params.env ?? process.env, signal: params.signal },
    (lease) => {
      const beforePersistentApply = () => {
        params.signal?.throwIfAborted();
        lease.assertOwned();
        params.beforePersistentApply?.();
      };
      beforePersistentApply();
      return run(beforePersistentApply, lease.assertOwned.bind(lease));
    },
  );
}

async function readPluginMutationSnapshot(
  env: NodeJS.ProcessEnv,
  beforePersistentApply: () => void,
): Promise<ConfigSnapshotForInstallPersist> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env });
    const snapshot = await loadConfigForInstall();
    return {
      ...snapshot,
      writeOptions: selectInstallMutationWriteOptions(snapshot.writeOptions, beforePersistentApply),
    };
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
}
function throwInstallFailure(result: SourceInstallFailure): never {
  const unavailable =
    !result.code ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
  throw new ManagedPluginLifecycleError(result.error, {
    ...result,
    kind: unavailable ? "unavailable" : "invalid-request",
    installRejected: true,
    cause: result,
  });
}
/** Install a reviewed source through the canonical artifact and runtime lifecycle. */
export async function installManagedPlugin(
  params: ManagedPluginInstallOptions & { request: PluginsInstallParams },
): Promise<{
  plugin: ManagedPluginCatalogEntry;
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(
    params,
    async (beforePersistentApply, assertLeaseOwned) => {
      const officialCatalog = await loadOfficialCatalog();
      const warnings: string[] = [];
      const installLogger = {
        terminalLinks: false,
        info: params.logger?.info,
        warn: (message: string) => warnings.push(message),
      };
      const request = resolveManagedPluginInstallRequest(params.request, officialCatalog.entries);
      assertConfigWriteAllowedInCurrentMode({ env });
      const context = resolvePluginInstallRequestContext({
        rawSpec:
          request.source === "local"
            ? request.path
            : request.source === "bundled"
              ? request.bundledSource.localPath
              : request.source === "npm-pack"
                ? `npm-pack:${request.archivePath}`
                : request.source === "marketplace"
                  ? request.plugin
                  : request.spec,
        ...(request.source === "marketplace" ? { marketplace: request.marketplace } : {}),
        installKind: "plugin",
      });
      if (!context.ok) {
        throw new ManagedPluginLifecycleError(context.error);
      }
      const snapshot = await loadConfigForInstall(context.request).catch((error: unknown) => {
        const source = request.source === "official" ? request.installSources[0] : undefined;
        if (
          error instanceof PluginInstallConfigError &&
          error.blockedSnapshot?.hookMutation.mode === "allowed" &&
          source?.source === "npm"
        ) {
          // No plugin installer ran. Only this catalog-selected artifact is
          // eligible for a separate hook-only inspection.
          const spec = resolveOfficialManagedInstallSpec({
            request: { ...source, trustedSourceLinkedOfficialInstall: true },
            config: error.blockedSnapshot.config,
          });
          throwInstallFailure({
            ok: false,
            error: error.message,
            code: PLUGIN_INSTALL_ERROR_CODE.CONFIG_MUTATION_BLOCKED,
            installSource: { ...source, spec: spec ?? source.spec },
          });
        }
        throw error;
      });
      const installed = await installManagedPluginSource({
        request,
        snapshot,
        env,
        assertLeaseOwned,
        beforePersistentEffect: params.beforePersistentEffect,
        recordPath: params.recordPath,
        applyRuntime: params.applyRuntime,
        beforePersistentApply: () => {
          snapshot.writeOptions.assertConfigPathForWrite?.();
          beforePersistentApply();
        },
        clawManaged: params.request.clawManaged,
        logger: installLogger,
        onCapabilityConsent: params.onCapabilityConsent,
        confirmInstall: params.request.source === "clawhub" ? params.confirmInstall : undefined,
        acknowledgeCapabilities: params.request.acknowledgeCapabilities,
        safetyOverrides: params.request.acknowledgeInstallPolicyWarning
          ? { onInstallPolicyWarning: async () => ({ status: "approved" as const }) }
          : params.safetyOverrides,
      });
      if (!installed.ok) {
        return throwInstallFailure(installed);
      }
      warnings.push(...(installed.warnings ?? []));
      if ("pin" in params.request && params.request.pin) {
        warnings.push(
          installed.npmResolution?.resolvedSpec
            ? `Pinned npm install record to ${installed.npmResolution.resolvedSpec}.`
            : "Could not resolve exact npm version for --pin; storing original npm spec.",
        );
      }
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
      const installedWarnings = [...new Set(warnings)];
      if (installedPluginIds.length > 1) {
        installedWarnings.unshift(
          `Installed package "${installed.pluginId}" with plugin entries: ${installedPluginIds.join(", ")}.`,
        );
      }
      return {
        plugin,
        ...(installed.application ? { application: installed.application } : {}),
        ...(installedWarnings.length > 0 ? { warnings: installedWarnings } : {}),
      };
    },
  );
}

/** Persist desired plugin policy while preserving allow/deny, slot, include, and hash guards. */
export async function setManagedPluginEnabled(
  params: ManagedPluginMutationOptions & {
    pluginId: string;
    enabled: boolean;
    requestCapabilityConsent?: boolean;
    acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    onCapabilityConsent?: PluginCapabilityConsentHandler;
  },
): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    const metadata = loadFreshManagedPluginMetadata(snapshot.config, env);
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const installedPlugin = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!installedPlugin) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    // The shipped CLI permits no-option enable of an already-enabled plugin. Offline
    // policy writes preserve that contract; applying runtime always verifies consent.
    if (
      params.enabled &&
      (params.applyRuntime ||
        !installedPlugin.enabled ||
        (params.requestCapabilityConsent ?? Boolean(params.onCapabilityConsent)) ||
        params.acknowledgeCapabilities)
    ) {
      await resolvePluginCapabilityConsent({
        config: snapshot.config,
        env,
        pluginId,
        acknowledge: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
        beforePersistentApply,
        metadata,
      });
    }
    let next = snapshot.config;
    const warnings: string[] = [];
    let policyPluginId = pluginId;
    if (params.enabled) {
      // An explicit enable is a trust action. Preserve the
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
      beforePersistentApply();
      const slotResult = applySlotSelectionForPlugin(next, pluginId, metadata);
      next = slotResult.config;
      warnings.push(...slotResult.warnings);
    } else {
      next = setPluginEnabledInConfig(next, pluginId, false, { updateChannelConfig: false });
    }
    const changedPaths = new Set<string>();
    collectChangedPaths(snapshot.config, next, "", changedPaths);
    const write = await replaceConfigFile({
      nextConfig: next,
      baseHash: snapshot.baseHash,
      writeOptions: {
        ...snapshot.writeOptions,
        // Persist the merged canonical entry, including compatibility-only settings.
        explicitSetPaths: [["plugins", "entries", policyPluginId]],
        ...(params.applyRuntime
          ? { afterWrite: { mode: "none" as const, reason: "plugin lifecycle applies runtime" } }
          : {}),
      },
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
    const application = await params.applyRuntime?.({
      config: next,
      write,
      pluginIds: [policyPluginId],
      reason: params.enabled ? "enable" : "disable",
      assertInvokerOwned: beforePersistentApply,
    });
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
      ...(application ? { application } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

async function prepareManagedPluginUninstall(params: {
  pluginId: string;
  keepFiles?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  // Uninstall also repairs stale plugin references in otherwise invalid config.
  // The final writer still validates the resulting config and include ownership.
  const prepared = await readConfigFileSnapshotForWrite();
  const snapshot: ConfigSnapshotForInstallPersist = {
    config: prepared.snapshot.sourceConfig,
    baseHash: prepared.snapshot.hash,
    writeOptions: selectInstallMutationWriteOptions(prepared.writeOptions),
  };
  const installRecords = await loadInstalledPluginIndexInstallRecords({ env });
  const configWithRecords = withPluginInstallRecords(snapshot.config, installRecords);
  const metadata = loadFreshManagedPluginMetadata(configWithRecords, env);
  const selected = resolvePluginUninstallId({
    rawId: params.pluginId,
    config: configWithRecords,
    plugins: metadata.manifestRegistry.plugins.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
    })),
  });
  if (!selected.ok) {
    throw new ManagedPluginLifecycleError(selected.error);
  }
  const { pluginId } = selected.value;
  const record = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
  if (record?.origin === "bundled") {
    throw new ManagedPluginLifecycleError(
      `bundled plugin cannot be uninstalled: ${pluginId}; disable it instead`,
    );
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
  // An orphan install id cannot claim channel config owned by another discovered plugin.
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
  // Package ownership stays under the lifecycle lease; config is reread after teardown.
  const planForConfig = (config: OpenClawConfig) => {
    const plan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: withPluginInstallRecords(config, installRecords),
          pluginId: installOwner,
          ...(channelIds !== undefined ? { channelIds } : {}),
          deleteFiles: !params.keepFiles,
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
    if (!plan.ok) {
      throw new ManagedPluginLifecycleError(plan.error);
    }
    return plan;
  };
  return {
    snapshot,
    installRecords,
    pluginId,
    installOwner,
    ownedPluginIds,
    policyPluginIds,
    channelIds,
    plan: planForConfig(snapshot.config),
    planForConfig,
    name: selected.value.plugin?.name ?? installOwner,
    warnings: collectClawPluginUninstallWarnings({
      pluginId: installOwner,
      installRecord: installRecords[installOwner],
      env,
    }),
  };
}

/** Preview the same package ownership and removal plan that the executor revalidates. */
export async function planManagedPluginUninstall(params: {
  pluginId: string;
  keepFiles?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const prepared = await prepareManagedPluginUninstall(params);
  const { plan, installOwner, ownedPluginIds, pluginId, snapshot, channelIds } = prepared;
  const preview = formatUninstallActionLabels(plan.actions).filter(
    (label) =>
      label !== UNINSTALL_ACTION_LABELS.memorySlot &&
      label !== UNINSTALL_ACTION_LABELS.contextEngineSlot &&
      label !== UNINSTALL_ACTION_LABELS.channelConfig,
  );
  for (const key of ["memory", "contextEngine"] as const) {
    if (plan.actions[key === "memory" ? "memorySlot" : "contextEngineSlot"]) {
      preview.push(formatUninstallSlotResetPreview(key));
    }
  }
  if (plan.actions.channelConfig) {
    for (const key of resolveUninstallChannelConfigKeys(installOwner, { channelIds })) {
      if (Object.hasOwn(snapshot.config.channels ?? {}, key)) {
        preview.push(`${UNINSTALL_ACTION_LABELS.channelConfig} (channels.${key})`);
      }
    }
  }
  if (plan.directoryRemoval) {
    preview.push(`directory: ${plan.directoryRemoval.target}`);
  }
  return {
    pluginId: installOwner,
    requestedPluginId: pluginId,
    pluginIds: ownedPluginIds,
    name: prepared.name,
    preview,
    warnings: prepared.warnings,
  };
}

/** Remove one package through the same durable and runtime lifecycle for every caller. */
export async function uninstallManagedPlugin(
  params: ManagedPluginMutationOptions & {
    pluginId: string;
    keepFiles?: boolean;
    clawManaged?: boolean;
    invalidateRuntimeCache?: boolean;
  },
): Promise<{
  pluginId: string;
  removed: string[];
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  assertConfigWriteAllowedInCurrentMode({ env });
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    let prepared = await prepareManagedPluginUninstall(params);
    const { installOwner, ownedPluginIds, policyPluginIds, pluginId } = prepared;
    const uninstall = async () => {
      let { plan, snapshot } = prepared;
      const { installRecords } = prepared;
      let directoryResult: Awaited<ReturnType<typeof applyPluginUninstallDirectoryRemoval>> = {
        directoryRemoved: false,
        warnings: [],
      };
      if (plan.directoryRemoval) {
        const disabledConfig = prepareConfigForDisabledPluginSet(snapshot.config, policyPluginIds);
        const write = await replaceConfigFile({
          nextConfig: disabledConfig,
          baseHash: snapshot.baseHash,
          writeOptions: {
            ...selectInstallMutationWriteOptions(snapshot.writeOptions, beforePersistentApply),
            afterWrite: params.applyRuntime
              ? { mode: "none", reason: "plugin lifecycle applies runtime" }
              : { mode: "auto" },
          },
        });
        // The runtime must release old imports and resources before their files disappear.
        await params.applyRuntime?.({
          config: disabledConfig,
          write,
          pluginIds: policyPluginIds,
          reason: "uninstall",
          assertInvokerOwned: beforePersistentApply,
        });
        // Runtime teardown yields; revalidate before removing the stopped plugin source.
        beforePersistentApply();
        directoryResult = await applyPluginUninstallDirectoryRemoval(
          plan.directoryRemoval,
          beforePersistentApply,
        );
        if (pluginUninstallTargetExists(plan.directoryRemoval.target)) {
          throw new ManagedPluginLifecycleError(
            `Failed to remove plugin directory ${plan.directoryRemoval.target}; the plugin remains disabled and tracked so uninstall can be retried.`,
            { kind: "unavailable" },
          );
        }
        const refreshed = await readConfigFileSnapshotForWrite();
        snapshot = {
          config: refreshed.snapshot.sourceConfig,
          baseHash: refreshed.snapshot.hash,
          writeOptions: selectInstallMutationWriteOptions(refreshed.writeOptions),
        };
        plan = prepared.planForConfig(snapshot.config);
      }
      const nextConfig = withoutPluginInstallRecords(plan.config);
      const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, installOwner);
      const write = await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: installRecords,
        nextInstallRecords,
        nextConfig,
        baseHash: snapshot.baseHash,
        beforePersistentEffect: beforePersistentApply,
        writeOptions: {
          ...selectInstallMutationWriteOptions(snapshot.writeOptions, beforePersistentApply),
          allowConfigSizeDrop: true,
          ...(params.applyRuntime
            ? { afterWrite: { mode: "none" as const, reason: "plugin lifecycle applies runtime" } }
            : {}),
        },
      });
      const warnings = [
        ...prepared.warnings,
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
        invalidateRuntimeCache: params.invalidateRuntimeCache ?? false,
        logger: { warn: (message) => warnings.push(message) },
      });
      refreshManagedPluginMetadata({ config: nextConfig, env });
      const application = await params.applyRuntime?.({
        config: nextConfig,
        write,
        pluginIds: policyPluginIds,
        reason: "uninstall",
        assertInvokerOwned: beforePersistentApply,
      });
      const removed = formatUninstallActionLabels({
        ...plan.actions,
        directory: directoryResult.directoryRemoved,
      });
      return {
        pluginId: installOwner,
        removed,
        ...(application ? { application } : {}),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
      };
    };
    const record = prepared.installRecords[installOwner];
    const clawhubPackage =
      record?.source === "clawhub"
        ? (record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name)
        : undefined;
    if (params.clawManaged || !clawhubPackage) {
      return await uninstall();
    }
    return await withClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: clawhubPackage },
      async () => {
        prepared = await prepareManagedPluginUninstall(params);
        return await uninstall();
      },
      { required: true },
    );
  });
}

/** Reload the selected installed package through the running Gateway's lifecycle owner. */
export async function reloadManagedPlugin(
  params: ManagedPluginMutationOptions & {
    pluginId: string;
    applyRuntime: PluginLifecycleRuntimeApply;
    acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    onCapabilityConsent?: PluginCapabilityConsentHandler;
  },
): Promise<{ pluginId: string; application: PluginRuntimeApplication }> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    const metadata = loadFreshManagedPluginMetadata(snapshot.config, env);
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    if (!metadata.index.plugins.some((plugin) => plugin.pluginId === pluginId)) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    const ownership = createInstalledPluginOwnershipResolver(metadata.index, env).resolveLifecycle(
      pluginId,
    );
    const pluginIds =
      ownership.ok && ownership.value.pluginIds.length > 0 ? ownership.value.pluginIds : [pluginId];
    await resolvePluginCapabilityConsent({
      config: snapshot.config,
      env,
      pluginId,
      metadata,
      acknowledge: params.acknowledgeCapabilities,
      onCapabilityConsent: params.onCapabilityConsent,
      beforePersistentApply,
    });
    return {
      pluginId,
      application: await params.applyRuntime({
        config: snapshot.config,
        pluginIds,
        reason: "reload",
        assertInvokerOwned: beforePersistentApply,
      }),
    };
  });
}

/** Apply an explicit metadata refresh under the same cross-process lifecycle lease. */
export async function refreshManagedPlugins(
  params: ManagedPluginMutationOptions & {
    applyRuntime: PluginLifecycleRuntimeApply;
  },
): Promise<{ application: PluginRuntimeApplication }> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    const metadata = refreshManagedPluginMetadata({ config: snapshot.config, env });
    return {
      application: await params.applyRuntime({
        config: snapshot.config,
        pluginIds: metadata.index.plugins.map((plugin) => plugin.pluginId),
        reason: "metadata",
        assertInvokerOwned: beforePersistentApply,
      }),
    };
  });
}
