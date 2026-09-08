// Prepared plugin runtime load facts and registry-owned context access.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { createSubsystemLogger } from "../../logging.js";
import { resolvePluginRegistrationConfigKey } from "../loader-registration-config.js";
import type { PluginLoadOptions } from "../loader-types.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import { resolvePluginControlPlaneFingerprint } from "../plugin-control-plane-context.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { buildDeclaredProviderOwnerIndex } from "../provider-owner-index.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginLogger } from "../types.js";
import {
  bindPluginRuntimeLoadContextState,
  getPluginRuntimeLoadContextState,
  type PluginRuntimeLoadContextState,
} from "./load-context-state.js";

const log = createSubsystemLogger("plugins");

/** Resolved plugin runtime load context shared by runtime loader callers. */
export type PluginRuntimeLoadContext = {
  rawConfig: OpenClawConfig;
  config: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  workspaceDir: string | undefined;
  env: NodeJS.ProcessEnv;
  logger: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  installRecords?: Record<string, PluginInstallRecord>;
  preferBuiltPluginArtifacts?: boolean;
};

export function setPluginRuntimeLoadContext(
  registry: PluginRegistry,
  context: PluginRuntimeLoadContext,
  registrationConfigKey?: string,
): void {
  const previous = getPluginRuntimeLoadContextState(registry);
  const bound = {
    ...context,
    // Host preparation may rebind metadata, but it cannot change already-registered closures.
    registrationConfigKey:
      previous?.registrationConfigKey ??
      registrationConfigKey ??
      resolvePluginRegistrationConfigKey(context),
    declaredProviderOwners:
      context.metadataSnapshot &&
      context.metadataSnapshot.manifestRegistry === context.manifestRegistry
        ? context.metadataSnapshot.declaredProviderOwners
        : buildDeclaredProviderOwnerIndex(context.manifestRegistry?.plugins ?? []),
    // Capture selection before caller-owned config or environment objects can change.
    controlPlaneFingerprint: resolvePluginControlPlaneFingerprint({
      config: context.rawConfig,
      env: context.env,
      workspaceDir: context.workspaceDir,
    }),
  };
  bindPluginRuntimeLoadContextState(registry, bound);
}

/** Reads load facts carried by an exact lifecycle-owned registry. */
export const getPluginRuntimeLoadContext = (
  registry: object | undefined,
): (PluginRuntimeLoadContext & PluginRuntimeLoadContextState) | undefined =>
  // SAFETY: setPluginRuntimeLoadContext is the sole writer and supplies all load facts.
  getPluginRuntimeLoadContextState(registry) as
    | (PluginRuntimeLoadContext & PluginRuntimeLoadContextState)
    | undefined;

/** Runtime load option values that can be passed directly to plugin loading. */
type PluginRuntimeResolvedLoadValues = Pick<
  PluginLoadOptions,
  | "config"
  | "activationSourceConfig"
  | "autoEnabledReasons"
  | "workspaceDir"
  | "env"
  | "logger"
  | "manifestRegistry"
  | "installRecords"
  | "preferBuiltPluginArtifacts"
>;

/** Creates the default plugin runtime loader logger. */
export function createPluginRuntimeLoaderLogger(): PluginLogger {
  return {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    debug: (message) => log.debug(message),
  };
}

/** Projects explicit runtime load fields from prepared contexts or resolved values. */
export function buildPluginRuntimeLoadOptions(
  values: PluginRuntimeResolvedLoadValues,
  overrides?: Partial<PluginLoadOptions>,
): PluginLoadOptions {
  return {
    config: values.config,
    activationSourceConfig: values.activationSourceConfig,
    autoEnabledReasons: values.autoEnabledReasons,
    workspaceDir: values.workspaceDir,
    env: values.env,
    logger: values.logger,
    manifestRegistry: values.manifestRegistry,
    installRecords: values.installRecords,
    preferBuiltPluginArtifacts: values.preferBuiltPluginArtifacts,
    ...overrides,
  };
}
