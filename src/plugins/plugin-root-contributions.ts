import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizePluginsConfigWithResolver,
  resolvePolicyPluginActivationState,
} from "./config-policy.js";
import { resolveMemorySlotDecision } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { hasKind } from "./slots.js";

/** Select active root contributions while leaving path validation and publication to consumers. */
export function* iteratePluginRootContributions(params: {
  metadataSnapshot: Pick<PluginMetadataSnapshot, "manifestRegistry" | "normalizePluginId">;
  config?: OpenClawConfig;
  contribution: "skills" | "hooks";
  /** Availability is checked after activation and before claiming a memory slot. */
  isAvailable?: (record: PluginManifestRecord) => boolean;
}): IterableIterator<{ record: PluginManifestRecord; roots: string[] }> {
  const normalizedPlugins = normalizePluginsConfigWithResolver(
    params.config?.plugins,
    params.metadataSnapshot.normalizePluginId,
  );
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  for (const record of params.metadataSnapshot.manifestRegistry.plugins) {
    const roots = record[params.contribution];
    if (!roots || roots.length === 0) {
      continue;
    }
    const activationState = resolvePolicyPluginActivationState({
      id: record.id,
      origin: record.origin,
      channelIds: record.channels,
      config: normalizedPlugins,
      rootConfig: params.config,
      // Skill roots honor manifest defaults; hook roots leave that activation input unset.
      ...(params.contribution === "skills" ? { enabledByDefault: record.enabledByDefault } : {}),
    });
    if (!activationState.activated || (params.isAvailable && !params.isAvailable(record))) {
      continue;
    }
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      continue;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      selectedMemoryPluginId = record.id;
    }
    yield { record, roots };
  }
}
