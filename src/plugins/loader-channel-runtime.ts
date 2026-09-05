import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeRootFileOpenFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import type { NormalizedPluginsConfig } from "./config-state.js";
import {
  channelPluginIdBelongsToManifest,
  loadBundledRuntimeChannelPlugin,
  mergeSetupRuntimeChannelPlugin,
  resolveBundledRuntimeChannelRegistration,
  resolveSetupChannelRegistration,
} from "./loader-channel-setup.js";
import type { PluginModuleLoader } from "./loader-module-runtime.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { recordPluginError } from "./loader-records.js";
import type { PluginRegistrationPlan } from "./loader-registration-plan.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { withProfile } from "./plugin-load-profile.js";
import { resolveCanonicalDistRuntimeSource } from "./plugin-runtime-artifact-resolution.js";
import type { createPluginRegistry, PluginRecord } from "./registry.js";
import type { OpenClawPluginModule, PluginLogger } from "./types.js";

type PluginRegistryBuilder = ReturnType<typeof createPluginRegistry>;

/**
 * Handles the setup-entry channel path.
 * Returns true when the candidate is complete (loaded, disabled, or failed).
 */
export function loadSetupRuntimeChannelCandidate(params: {
  mod: OpenClawPluginModule | null;
  manifestRecord: PluginManifestRecord;
  record: PluginRecord;
  registrationPlan: PluginRegistrationPlan;
  runtimeCandidateEntry: { source: string; rootDir: string };
  safeSource: string;
  rejectHardlinks: boolean;
  loadPluginModule: PluginModuleLoader;
  registryBuilder: PluginRegistryBuilder;
  cfg: OpenClawConfig;
  entry: NormalizedPluginsConfig["entries"][string] | undefined;
  seenIds: Map<string, PluginRecord["origin"]>;
  candidateOrigin: PluginRecord["origin"];
  logger: PluginLogger;
  pushPluginLoadError: (message: string) => void;
}): boolean {
  const { manifestRecord, record, registrationPlan, runtimeCandidateEntry, registryBuilder } =
    params;
  if (!registrationPlan.loadSetupEntry || !manifestRecord.setupSource) {
    return false;
  }
  // Registration rollback can restore record fields, so read them only when reporting.
  const recordSetupFailure = (error: unknown, phase: "load" | "register", message: string) => {
    recordPluginError({
      logger: params.logger,
      registry: registryBuilder.registry,
      record,
      seenIds: params.seenIds,
      pluginId: record.id,
      origin: params.candidateOrigin,
      phase,
      error,
      logPrefix: `[plugins] ${record.id} ${message} from ${record.source}: `,
      diagnosticMessagePrefix: `${message}: `,
      diagnosticCode: "channel-setup-failure",
    });
  };
  const setupRegistration = resolveSetupChannelRegistration(params.mod);
  if (setupRegistration.loadError) {
    recordSetupFailure(setupRegistration.loadError, "load", "failed to load setup entry");
    return true;
  }
  if (!setupRegistration.plugin) {
    return false;
  }
  if (
    !channelPluginIdBelongsToManifest({
      channelId: setupRegistration.plugin.id,
      pluginId: record.id,
      manifestChannels: manifestRecord.channels,
    })
  ) {
    params.pushPluginLoadError(
      `plugin id mismatch (config uses "${record.id}", setup export uses "${setupRegistration.plugin.id}")`,
    );
    return true;
  }
  const api = registryBuilder.createApi(record, {
    config: params.cfg,
    pluginConfig: {},
    hookPolicy: params.entry?.hooks,
    registrationMode: registrationPlan.mode,
  });
  let mergedSetupRegistration = setupRegistration;
  let runtimeSetterApplied = false;
  if (
    registrationPlan.loadSetupRuntimeEntry &&
    setupRegistration.usesBundledSetupContract &&
    resolveCanonicalDistRuntimeSource(runtimeCandidateEntry.source) !== params.safeSource
  ) {
    const runtimeModuleSource = resolveCanonicalDistRuntimeSource(runtimeCandidateEntry.source);
    const runtimeModuleRoot = resolveCanonicalDistRuntimeSource(runtimeCandidateEntry.rootDir);
    const runtimeOpened = openRootFileSync({
      absolutePath: runtimeModuleSource,
      rootPath: runtimeModuleRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: params.rejectHardlinks,
      skipLexicalRootCheck: true,
    });
    if (!runtimeOpened.ok) {
      params.pushPluginLoadError(
        describeRootFileOpenFailure({
          failure: runtimeOpened,
          subject: "plugin entry path",
          boundaryLabel: "plugin root",
          filePath: runtimeModuleSource,
        }),
      );
      return true;
    }
    const safeRuntimeSource = runtimeOpened.path;
    fs.closeSync(runtimeOpened.fd);
    let runtimeMod: OpenClawPluginModule | null;
    try {
      runtimeMod = withProfile(
        { pluginId: record.id, source: safeRuntimeSource },
        "load-setup-runtime-entry",
        () => params.loadPluginModule(safeRuntimeSource) as OpenClawPluginModule,
      );
    } catch (error) {
      recordSetupFailure(error, "load", "failed to load setup-runtime entry");
      return true;
    }
    const runtimeRegistration = resolveBundledRuntimeChannelRegistration(runtimeMod);
    if (runtimeRegistration.id && runtimeRegistration.id !== record.id) {
      params.pushPluginLoadError(
        `plugin id mismatch (config uses "${record.id}", runtime entry uses "${runtimeRegistration.id}")`,
      );
      return true;
    }
    if (runtimeRegistration.setChannelRuntime) {
      try {
        runtimeRegistration.setChannelRuntime(api.runtime);
        runtimeSetterApplied = true;
      } catch (error) {
        recordSetupFailure(error, "load", "failed to apply setup-runtime channel runtime");
        return true;
      }
    }
    const runtimePluginRegistration = loadBundledRuntimeChannelPlugin({
      registration: runtimeRegistration,
    });
    if (runtimePluginRegistration.loadError) {
      recordSetupFailure(
        runtimePluginRegistration.loadError,
        "load",
        "failed to load setup-runtime channel entry",
      );
      return true;
    }
    if (runtimePluginRegistration.plugin) {
      if (
        runtimePluginRegistration.plugin.id &&
        runtimePluginRegistration.plugin.id !== record.id
      ) {
        params.pushPluginLoadError(
          `plugin id mismatch (config uses "${record.id}", runtime export uses "${runtimePluginRegistration.plugin.id}")`,
        );
        return true;
      }
      mergedSetupRegistration = {
        ...setupRegistration,
        plugin: mergeSetupRuntimeChannelPlugin(
          runtimePluginRegistration.plugin,
          setupRegistration.plugin,
        ),
        setChannelRuntime:
          runtimeRegistration.setChannelRuntime ?? setupRegistration.setChannelRuntime,
      };
    }
  }
  const mergedSetupPlugin = mergedSetupRegistration.plugin;
  if (!mergedSetupPlugin) {
    return true;
  }
  if (
    !channelPluginIdBelongsToManifest({
      channelId: mergedSetupPlugin.id,
      pluginId: record.id,
      manifestChannels: manifestRecord.channels,
    })
  ) {
    params.pushPluginLoadError(
      `plugin id mismatch (config uses "${record.id}", setup export uses "${mergedSetupPlugin.id}")`,
    );
    return true;
  }
  if (!runtimeSetterApplied) {
    try {
      mergedSetupRegistration.setChannelRuntime?.(api.runtime);
    } catch (error) {
      recordSetupFailure(error, "load", "failed to apply setup channel runtime");
      return true;
    }
  }
  if (registrationPlan.mode === "setup-runtime" && mergedSetupRegistration.registerSetupRuntime) {
    try {
      runPluginRegisterSyncInRegistry(
        (registrationApi) => mergedSetupRegistration.registerSetupRuntime?.(registrationApi),
        api,
        registryBuilder.registry,
        record.id,
      );
    } catch (error) {
      registryBuilder.rollbackPluginGlobalSideEffects(record.id, record);
      recordSetupFailure(
        error,
        "register",
        "failed to register setup-runtime channel side effects",
      );
      return true;
    }
  }
  try {
    api.registerChannel(mergedSetupPlugin);
  } catch (error) {
    // Setup-runtime registration may already have added contributions.
    // Roll them back before recording the channel registration failure.
    registryBuilder.rollbackPluginGlobalSideEffects(record.id, record);
    recordSetupFailure(error, "load", "failed to register setup channel");
    return true;
  }
  registryBuilder.registry.plugins.push(record);
  params.seenIds.set(record.id, params.candidateOrigin);
  return true;
}
