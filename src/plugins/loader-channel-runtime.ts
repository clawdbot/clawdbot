import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import type { NormalizedPluginsConfig } from "./config-state.js";
import {
  channelPluginIdBelongsToManifest,
  loadBundledRuntimeChannelPlugin,
  mergeSetupRuntimeChannelPlugin,
  resolveBundledRuntimeChannelRegistration,
  resolveSetupChannelRegistration,
  shouldDeferConfiguredChannelFullRuntimeMerge,
} from "./loader-channel-setup.js";
import type { PluginModuleLoader } from "./loader-module-runtime.js";
import { runPluginRegisterSync } from "./loader-module-runtime.js";
import { recordPluginError } from "./loader-records.js";
import type { PluginRegistrationPlan } from "./loader-registration-plan.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { withProfile } from "./plugin-load-profile.js";
import { createPluginRegistrationTransaction } from "./plugin-registration-transaction.js";
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
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins: boolean;
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
  const setupRegistration = resolveSetupChannelRegistration(params.mod);
  if (setupRegistration.loadError) {
    recordPluginError({
      logger: params.logger,
      registry: registryBuilder.registry,
      record,
      seenIds: params.seenIds,
      pluginId: record.id,
      origin: params.candidateOrigin,
      phase: "load",
      error: setupRegistration.loadError,
      logPrefix: `[plugins] ${record.id} failed to load setup entry from ${record.source}: `,
      diagnosticMessagePrefix: "failed to load setup entry: ",
      diagnosticCode: "channel-setup-failure",
    });
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
    !shouldDeferConfiguredChannelFullRuntimeMerge({
      manifestChannels: manifestRecord.channels,
      startupDeferConfiguredChannelFullLoadUntilAfterListen:
        manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
      cfg: params.cfg,
      env: params.env,
      preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    }) &&
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
      params.pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
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
      recordPluginError({
        logger: params.logger,
        registry: registryBuilder.registry,
        record,
        seenIds: params.seenIds,
        pluginId: record.id,
        origin: params.candidateOrigin,
        phase: "load",
        error,
        logPrefix: `[plugins] ${record.id} failed to load setup-runtime entry from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load setup-runtime entry: ",
        diagnosticCode: "channel-setup-failure",
      });
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
        recordPluginError({
          logger: params.logger,
          registry: registryBuilder.registry,
          record,
          seenIds: params.seenIds,
          pluginId: record.id,
          origin: params.candidateOrigin,
          phase: "load",
          error,
          logPrefix: `[plugins] ${record.id} failed to apply setup-runtime channel runtime from ${record.source}: `,
          diagnosticMessagePrefix: "failed to apply setup-runtime channel runtime: ",
          diagnosticCode: "channel-setup-failure",
        });
        return true;
      }
    }
    const runtimePluginRegistration = loadBundledRuntimeChannelPlugin({
      registration: runtimeRegistration,
    });
    if (runtimePluginRegistration.loadError) {
      recordPluginError({
        logger: params.logger,
        registry: registryBuilder.registry,
        record,
        seenIds: params.seenIds,
        pluginId: record.id,
        origin: params.candidateOrigin,
        phase: "load",
        error: runtimePluginRegistration.loadError,
        logPrefix: `[plugins] ${record.id} failed to load setup-runtime channel entry from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load setup-runtime channel entry: ",
        diagnosticCode: "channel-setup-failure",
      });
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
      recordPluginError({
        logger: params.logger,
        registry: registryBuilder.registry,
        record,
        seenIds: params.seenIds,
        pluginId: record.id,
        origin: params.candidateOrigin,
        phase: "load",
        error,
        logPrefix: `[plugins] ${record.id} failed to apply setup channel runtime from ${record.source}: `,
        diagnosticMessagePrefix: "failed to apply setup channel runtime: ",
        diagnosticCode: "channel-setup-failure",
      });
      return true;
    }
  }
  if (registrationPlan.mode === "setup-runtime" && mergedSetupRegistration.registerSetupRuntime) {
    const transaction = createPluginRegistrationTransaction({ registry: registryBuilder.registry });
    try {
      runPluginRegisterSync(
        (registrationApi) => mergedSetupRegistration.registerSetupRuntime?.(registrationApi),
        api,
      );
      transaction.commit({ activate: true });
    } catch (error) {
      transaction.rollback();
      recordPluginError({
        logger: params.logger,
        registry: registryBuilder.registry,
        record,
        seenIds: params.seenIds,
        pluginId: record.id,
        origin: params.candidateOrigin,
        phase: "register",
        error,
        logPrefix: `[plugins] ${record.id} failed to register setup-runtime channel side effects from ${record.source}: `,
        diagnosticMessagePrefix: "failed to register setup-runtime channel side effects: ",
        diagnosticCode: "channel-setup-failure",
      });
      return true;
    }
  }
  try {
    api.registerChannel(mergedSetupPlugin);
  } catch (error) {
    recordPluginError({
      logger: params.logger,
      registry: registryBuilder.registry,
      record,
      seenIds: params.seenIds,
      pluginId: record.id,
      origin: params.candidateOrigin,
      phase: "load",
      error,
      logPrefix: `[plugins] ${record.id} failed to register setup channel from ${record.source}: `,
      diagnosticMessagePrefix: "failed to register setup channel: ",
      diagnosticCode: "channel-setup-failure",
    });
    return true;
  }
  registryBuilder.registry.plugins.push(record);
  params.seenIds.set(record.id, params.candidateOrigin);
  return true;
}
