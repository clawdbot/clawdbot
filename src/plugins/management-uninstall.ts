// Plans and commits package-owned uninstall state for CLI and management callers.
import { ok, err, type Result } from "@openclaw/normalization-core/result";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { shortenHomePath } from "../utils.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import { readPluginMutationSnapshot } from "./management-config.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  loadFreshManagedPluginMetadata,
  refreshManagedPluginMetadata,
} from "./management-service.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "./plugin-lifecycle-trace.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { buildPluginSnapshotReport } from "./status.js";
import { collectClawPluginUninstallWarnings } from "./uninstall-claw-references.js";
import {
  prepareConfigForDisabledPluginSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import { resolvePluginUninstallId } from "./uninstall-selection.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  planPluginUninstall,
  pluginUninstallTargetExists,
} from "./uninstall.js";

type UninstallRequest = { pluginId: string; env?: NodeJS.ProcessEnv; keepFiles?: boolean };
type UninstallPolicy = UninstallRequest & { caller: "cli" | "management" };
export type PreparedPluginUninstall = {
  snapshot: ConfigSnapshotForInstallPersist;
  installRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  pluginId: string;
  requestedPluginId: string;
  pluginIds: string[];
  policyPluginIds: string[];
  name: string;
  channelIds: string[] | undefined;
  plan: Extract<ReturnType<typeof planPluginUninstall>, { ok: true }>;
  planForConfig: (config: OpenClawConfig) => ReturnType<typeof planPluginUninstall>;
};

type PluginUninstallOutcome = Pick<
  PreparedPluginUninstall,
  "pluginId" | "requestedPluginId" | "pluginIds"
> & {
  removed: string[];
  warnings: string[];
};

function runUninstallPhase<T>(
  params: UninstallPolicy,
  phase: string,
  run: () => Promise<T>,
): Promise<T> {
  return params.caller === "cli"
    ? tracePluginLifecyclePhaseAsync(phase, run, { command: "uninstall" })
    : run();
}

async function readUninstallSnapshot(
  params: UninstallPolicy,
  phase: string,
): Promise<ConfigSnapshotForInstallPersist> {
  return await runUninstallPhase(params, phase, async () => {
    if (params.caller === "management") {
      return await readPluginMutationSnapshot(params.env ?? process.env);
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    return {
      config: snapshot.sourceConfig,
      baseHash: snapshot.hash,
      writeOptions: selectInstallMutationWriteOptions(writeOptions),
    };
  });
}

/** Read-only plan; execution always replans under its lease after confirmation. */
export async function preparePluginUninstall(
  params: UninstallPolicy,
): Promise<Result<PreparedPluginUninstall, string>> {
  const env = params.env ?? process.env;
  const cli = params.caller === "cli";
  const snapshot = await readUninstallSnapshot(params, "config read");
  const installRecords = await runUninstallPhase(params, "install records load", () =>
    loadInstalledPluginIndexInstallRecords(cli ? {} : { env }),
  );
  const config = withPluginInstallRecords(snapshot.config, installRecords);
  // CLI selection uses its status projection; management retains its broader metadata aliases.
  const metadata = cli ? undefined : loadFreshManagedPluginMetadata(config, env);
  const index = metadata?.index ?? loadInstalledPluginIndex({ config, installRecords });
  const plugins = metadata
    ? metadata.index.plugins.map((record) => {
        const manifest = metadata.byPluginId.get(record.pluginId);
        return {
          id: record.pluginId,
          name: manifest?.name ?? record.pluginId,
          origin: record.origin,
          source: manifest?.source,
          channelIds: manifest?.channels,
        };
      })
    : tracePluginLifecyclePhase(
        "plugin registry snapshot",
        () => buildPluginSnapshotReport({ config }),
        { command: "uninstall" },
      ).plugins;
  const requestedId = metadata
    ? metadata.normalizePluginId(params.pluginId.trim())
    : params.pluginId;
  const selection: Result<{ pluginId: string; plugin?: (typeof plugins)[number] }, string> = cli
    ? resolvePluginUninstallId({ rawId: requestedId, config, plugins })
    : ok({ pluginId: requestedId, plugin: plugins.find((plugin) => plugin.id === requestedId) });
  if (!selection.ok) {
    return selection;
  }
  const { pluginId: requestedPluginId, plugin } = selection.value;
  if (!cli) {
    if (plugin?.origin === "bundled") {
      return err(`bundled plugin cannot be uninstalled: ${requestedPluginId}; disable it instead`);
    }
    if (!plugin && !Object.hasOwn(installRecords, requestedPluginId)) {
      return err(`Plugin not found: ${requestedPluginId}`);
    }
  }
  const ownership = createInstalledPluginOwnershipResolver(index, env).resolveLifecycle(
    requestedPluginId,
  );
  if (!ownership.ok) {
    return ownership;
  }
  const { installOwner: pluginId, pluginIds } = ownership.value;
  const policyPluginIds = pluginIds.length ? pluginIds : [pluginId];
  let channelIds: string[] | undefined;
  if (cli) {
    if (pluginIds.length === 1 && pluginIds[0] === requestedPluginId) {
      channelIds = plugin?.channelIds;
    } else if (pluginIds.length) {
      channelIds = uniqueStrings(
        pluginIds.flatMap((id) => plugins.find((entry) => entry.id === id)?.channelIds ?? []),
      );
    } else if (
      createInstalledPluginIndexScopeLookup(index).hasChannelContributionOwners([pluginId])
    ) {
      channelIds = [];
    }
  } else {
    const manifests = pluginIds.flatMap((id) => metadata?.byPluginId.get(id) ?? []);
    channelIds = manifests.length
      ? uniqueStrings(manifests.flatMap((manifest) => manifest.channels))
      : ownership.value.kind === "orphan" &&
          createInstalledPluginIndexScopeLookup(index).hasChannelContributionOwners([pluginId])
        ? []
        : undefined;
  }
  const runtimeLoadPaths = pluginIds.flatMap(
    (id) => plugins.find((entry) => entry.id === id)?.source ?? [],
  );
  const extensionsDir = resolveDefaultPluginExtensionsDir(cli ? undefined : env);
  const planForConfig = (source: OpenClawConfig) =>
    planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: withPluginInstallRecords(source, installRecords),
          pluginId,
          ...(channelIds !== undefined ? { channelIds } : {}),
          deleteFiles: !params.keepFiles,
          extensionsDir,
        },
        { runtimePluginIds: policyPluginIds, runtimeLoadPaths },
      ),
    );
  const plan = planForConfig(snapshot.config);
  if (!plan.ok) {
    return err(
      cli && plugin
        ? `Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`
        : plan.error,
    );
  }
  return ok({
    snapshot,
    installRecords,
    pluginId,
    requestedPluginId,
    pluginIds,
    policyPluginIds,
    name: plugin?.name || pluginId,
    channelIds,
    plan,
    planForConfig,
  });
}

/** Shared leased removal; callbacks preserve CLI output at its original mutation boundaries. */
export async function uninstallPluginWithPolicy(
  params: UninstallPolicy & {
    clawManaged?: boolean;
    invalidateRuntimeCache?: boolean;
    beforePersistentApply?: () => void;
    onPreview?: (preview: PreparedPluginUninstall) => void;
    onWarning?: (warning: string) => void;
    onComplete?: (result: PluginUninstallOutcome) => void;
  },
): Promise<Result<PluginUninstallOutcome, string>> {
  const env = params.env ?? process.env;
  const cli = params.caller === "cli";
  // Nested CLI calls inherit a Claw owner's exact database lease.
  return await withPluginLifecycleLease(cli ? {} : { env }, async () => {
    if (cli) {
      assertConfigWriteAllowedInCurrentMode();
    }
    const preparation = await preparePluginUninstall(params);
    if (!preparation.ok) {
      return preparation;
    }
    const prepared = preparation.value;
    params.onPreview?.(prepared);
    const uninstall = async (): Promise<Result<PluginUninstallOutcome, string>> => {
      const {
        pluginId,
        requestedPluginId,
        pluginIds,
        policyPluginIds,
        installRecords,
        plan: initialPlan,
      } = prepared;
      let plan = initialPlan;
      let snapshot = prepared.snapshot;
      const guardedWriteOptions = (options: ConfigSnapshotForInstallPersist["writeOptions"]) =>
        params.beforePersistentApply
          ? {
              ...options,
              assertConfigPathForWrite: () => {
                options.assertConfigPathForWrite?.();
                params.beforePersistentApply?.();
              },
            }
          : options;
      let directoryResult: Awaited<ReturnType<typeof applyPluginUninstallDirectoryRemoval>> = {
        directoryRemoved: false,
        warnings: [],
      };
      if (plan.directoryRemoval) {
        // Remove owned aliases while their realpath still exists; failed deletion remains retryable.
        await runUninstallPhase(params, "config disable", () =>
          replaceConfigFile({
            nextConfig: prepareConfigForDisabledPluginSet(
              snapshot.config,
              policyPluginIds,
              plan.config,
            ),
            baseHash: snapshot.baseHash,
            writeOptions: {
              ...guardedWriteOptions(snapshot.writeOptions),
              afterWrite: { mode: "auto" },
            },
          }),
        );
        params.beforePersistentApply?.();
        directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
        for (const warning of directoryResult.warnings) {
          params.onWarning?.(warning);
        }
        if (pluginUninstallTargetExists(plan.directoryRemoval.target)) {
          const message = `Failed to remove plugin directory ${cli ? shortenHomePath(plan.directoryRemoval.target) : plan.directoryRemoval.target}; the plugin remains disabled and tracked so uninstall can be retried.`;
          throw cli
            ? new Error(message)
            : new ManagedPluginLifecycleError(message, { kind: "unavailable" });
        }
        snapshot = await readUninstallSnapshot(params, "config reread");
        const refreshed = prepared.planForConfig(snapshot.config);
        if (!refreshed.ok) {
          throw cli ? new Error(refreshed.error) : new ManagedPluginLifecycleError(refreshed.error);
        }
        plan = refreshed;
      }
      const nextConfig = withoutPluginInstallRecords(plan.config);
      const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
      await runUninstallPhase(params, "config mutation", () =>
        commitPluginInstallRecordsWithConfig({
          previousInstallRecords: installRecords,
          nextInstallRecords,
          nextConfig,
          baseHash: snapshot.baseHash,
          writeOptions: {
            ...guardedWriteOptions(snapshot.writeOptions),
            ...(cli
              ? {
                  allowConfigSizeDrop: true,
                  afterWrite: { mode: "restart" as const, reason: "plugin source changed" },
                }
              : {}),
          },
        }),
      );
      const warnings = [
        ...(!cli
          ? collectClawPluginUninstallWarnings({
              pluginId,
              installRecord: installRecords[pluginId],
              env,
            })
          : []),
        ...(!cli && (requestedPluginId !== pluginId || pluginIds.length > 1)
          ? [
              `Uninstalled package "${pluginId}" and all owned plugin entries: ${pluginIds.join(", ")}.`,
            ]
          : []),
        ...directoryResult.warnings,
      ];
      await refreshPluginRegistryAfterConfigMutation({
        config: nextConfig,
        env,
        reason: "source-changed",
        installRecords: nextInstallRecords,
        invalidateRuntimeCache: cli ? params.invalidateRuntimeCache : false,
        ...(cli ? { traceCommand: "uninstall" } : {}),
        logger: {
          warn: (message) => {
            warnings.push(message);
            params.onWarning?.(message);
          },
        },
      });
      if (!cli) {
        refreshManagedPluginMetadata({ config: nextConfig, env });
      }
      const result = {
        pluginId,
        requestedPluginId,
        pluginIds,
        removed: formatUninstallActionLabels({
          ...plan.actions,
          loadPath: initialPlan.actions.loadPath || plan.actions.loadPath,
          directory: directoryResult.directoryRemoved,
        }),
        warnings: [...new Set(warnings)],
      };
      // Report committed work before either lease fence can raise a late ownership error.
      params.onComplete?.(result);
      return ok(result);
    };
    const record = prepared.installRecords[prepared.pluginId];
    const packageName =
      record?.source === "clawhub"
        ? (record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name)
        : undefined;
    if (!cli || params.clawManaged || !packageName) {
      return await uninstall();
    }
    return await withClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: packageName },
      uninstall,
      { required: true },
    );
  });
}

/** Preserve the management API's canonical-id admission and response shape. */
export async function uninstallManagedPlugin(params: {
  pluginId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pluginId: string; removed: string[]; warnings?: string[] }> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const result = await uninstallPluginWithPolicy({ ...params, caller: "management" });
    if (!result.ok) {
      throw new ManagedPluginLifecycleError(result.error);
    }
    const { pluginId, removed, warnings } = result.value;
    return { pluginId, removed, ...(warnings.length ? { warnings } : {}) };
  });
}
