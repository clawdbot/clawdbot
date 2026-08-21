import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig, resolvePluginActivationState } from "../plugins/config-state.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import {
  type BundledNodeHostPlugin,
  MAC_NODE_HOST_PLUGIN_DEFINITIONS,
} from "./mac-node-host-plugin-definitions.js";

/** Builds the non-CUA plugin command registry entirely from signed bundle code. */
export function createMacNodeHostPluginRegistry(
  config: OpenClawConfig,
  plugins: readonly BundledNodeHostPlugin[] = MAC_NODE_HOST_PLUGIN_DEFINITIONS,
): PluginRegistry {
  const runtime = createPluginRuntime();
  const logger = createSubsystemLogger("node-host/macos-bundled-plugins");
  const normalized = normalizePluginsConfig(config.plugins);
  const builder = createPluginRegistry({
    logger,
    runtime,
    activateGlobalSideEffects: false,
  });
  const { registry } = builder;

  for (const { definition, enabledByDefault } of plugins) {
    const activation = resolvePluginActivationState({
      id: definition.id,
      origin: "bundled",
      config: normalized,
      rootConfig: config,
      enabledByDefault,
    });
    const source = `embedded://mac-node-host/${definition.id}`;
    const record = createPluginRecord({
      id: definition.id,
      name: definition.name,
      version: definition.version,
      description: definition.description,
      source,
      origin: "bundled",
      enabled: activation.enabled,
      activationState: activation,
      configSchema: definition.configSchema !== undefined,
    });
    if (!activation.enabled || typeof definition.register !== "function") {
      registry.plugins.push(record);
      continue;
    }
    const pluginConfig = asOptionalRecord(normalized.entries[definition.id]?.config);
    const api = builder.createApi(record, {
      config,
      ...(pluginConfig ? { pluginConfig } : {}),
      registrationMode: "discovery",
    });
    try {
      runPluginRegisterSyncInRegistry(definition.register, api, registry, definition.id);
      registry.plugins.push(record);
    } catch (error) {
      builder.rollbackPluginGlobalSideEffects(definition.id, record);
      record.status = "error";
      record.error = formatErrorMessage(error);
      record.failurePhase = "register";
      registry.plugins.push(record);
      logger.warn(`bundled node-host plugin ${definition.id} failed: ${record.error}`);
    }
  }
  return registry;
}
