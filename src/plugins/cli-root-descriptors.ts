/** Resolves root CLI help from process-stable manifests before plugin code loads. */
import { collectUniqueCommandDescriptors } from "../cli/program/command-descriptor-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCliLoaderOptions } from "./cli-registry-loader.js";
import { normalizePluginsConfig, resolveMemorySlotDecision } from "./config-state.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import { validatePluginConfig } from "./loader-shared.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { hasKind } from "./slots.js";
import type { OpenClawPluginCliRootCommandDescriptor, PluginLogger } from "./types.js";

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} satisfies PluginLogger;

export async function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<OpenClawPluginCliRootCommandDescriptor[]> {
  const descriptorGroups: OpenClawPluginCliRootCommandDescriptor[][] = [];
  try {
    const context = resolvePluginRuntimeLoadContext({ config: cfg, env, logger: quietLogger });
    const snapshot = context.metadataSnapshot;
    if (!snapshot) {
      return [];
    }
    const legacyExternalPluginIds: string[] = [];
    const seenPluginIds = new Set<string>();
    let selectedMemoryPluginId: string | null = null;
    const memorySlot = context.config.plugins?.slots?.memory;
    const normalizedConfig = normalizePluginsConfig(context.config.plugins);
    const sourceConfig = normalizePluginsConfig(context.activationSourceConfig.plugins);

    for (const plugin of snapshot.plugins) {
      if (seenPluginIds.has(plugin.id)) {
        continue;
      }
      seenPluginIds.add(plugin.id);
      if (!isInstalledPluginEnabled(snapshot.index, plugin.id, context.config)) {
        continue;
      }
      const pluginConfig = normalizedConfig.entries[normalizePluginPolicyId(plugin.id)]?.config;
      if (
        !validatePluginConfig({
          schema: plugin.configSchema,
          cacheKey: plugin.schemaCacheKey,
          value: pluginConfig,
          sourceValue: plugin.configContracts?.secretInputs
            ? sourceConfig.entries[normalizePluginPolicyId(plugin.id)]?.config
            : undefined,
        }).ok
      ) {
        continue;
      }
      const memoryDecision = resolveMemorySlotDecision({
        id: plugin.id,
        kind: plugin.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        continue;
      }
      if (memoryDecision.selected && hasKind(plugin.kind, "memory")) {
        selectedMemoryPluginId = plugin.id;
      }
      if (plugin.cliCommands) {
        descriptorGroups.push(plugin.cliCommands);
      } else if (plugin.origin !== "bundled" && plugin.format !== "bundle") {
        legacyExternalPluginIds.push(plugin.id);
      }
    }

    if (legacyExternalPluginIds.length > 0) {
      const { loadOpenClawPluginCliRegistry } = await import("./loader.js");
      const registry = await loadOpenClawPluginCliRegistry(
        buildPluginRuntimeLoadOptions(context, {
          ...loaderOptions,
          onlyPluginIds: legacyExternalPluginIds,
        }),
      );
      descriptorGroups.push(
        ...registry.cliRegistrars
          .filter((entry) => (entry.parentPath ?? []).length === 0)
          .map((entry) => entry.descriptors),
      );
    }
    return collectUniqueCommandDescriptors(descriptorGroups);
  } catch {
    return collectUniqueCommandDescriptors(descriptorGroups);
  }
}
