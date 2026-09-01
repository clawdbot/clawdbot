// Prepared plugin runtime load facts and registry-owned context access.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { createSubsystemLogger } from "../../logging.js";
import type { PluginLoadOptions } from "../loader.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginLogger } from "../types.js";

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

// Source and built consumers must read the same facts from the owning registry.
const pluginRuntimeLoadContext = Symbol.for("openclaw.pluginRuntimeLoadContext");
type RuntimeContextRegistry = PluginRegistry & {
  [pluginRuntimeLoadContext]?: PluginRuntimeLoadContext;
};

export function setPluginRuntimeLoadContext(
  registry: PluginRegistry,
  context: PluginRuntimeLoadContext,
): void {
  // SAFETY: Internal registries are extensible; this module owns the optional symbol slot.
  (registry as RuntimeContextRegistry)[pluginRuntimeLoadContext] = context;
}

/** Reads load facts carried by an exact lifecycle-owned registry. */
export const getPluginRuntimeLoadContext = (
  registry: PluginRegistry | undefined,
): PluginRuntimeLoadContext | undefined =>
  // SAFETY: Only the setter above writes this optional registry-owned symbol slot.
  (registry as RuntimeContextRegistry | undefined)?.[pluginRuntimeLoadContext];

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

/** Builds plugin load options from a resolved runtime load context. */
export function buildPluginRuntimeLoadOptions(
  context: PluginRuntimeLoadContext,
  overrides?: Partial<PluginLoadOptions>,
): PluginLoadOptions {
  return buildPluginRuntimeLoadOptionsFromValues(context, overrides);
}

/** Builds plugin load options from explicit runtime load values. */
export function buildPluginRuntimeLoadOptionsFromValues(
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
