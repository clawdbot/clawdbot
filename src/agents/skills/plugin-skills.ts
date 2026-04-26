import fs from "node:fs";
import path from "node:path";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizePluginsConfigWithResolver,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../../plugins/config-policy.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import { hasKind } from "../../plugins/slots.js";
import { isPathInsideWithRealpath } from "../../security/scan-paths.js";

const log = createSubsystemLogger("skills");

function buildRegistryPluginIdAliases(
  registry: PluginManifestRegistry,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    registry.plugins
      .flatMap((record) => [
        ...record.providers
          .filter((providerId) => providerId !== record.id)
          .map((providerId) => [providerId, record.id] as const),
        ...(record.legacyPluginIds ?? []).map(
          (legacyPluginId) => [legacyPluginId, record.id] as const,
        ),
      ])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function createRegistryPluginIdNormalizer(
  registry: PluginManifestRegistry,
): (id: string) => string {
  const aliases = buildRegistryPluginIdAliases(registry);
  return (id: string) => {
    const trimmed = id.trim();
    return aliases[trimmed] ?? trimmed;
  };
}

export function resolvePluginSkillDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): string[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return [];
  }
  const registry = loadPluginManifestRegistryForPluginRegistry({
    workspaceDir,
    config: params.config,
    includeDisabled: true,
  });
  if (registry.plugins.length === 0) {
    return [];
  }
  const normalizedPlugins = normalizePluginsConfigWithResolver(
    params.config?.plugins,
    createRegistryPluginIdNormalizer(registry),
  );
  const acpRuntimeAvailable = isAcpRuntimeSpawnAvailable({ config: params.config });
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const record of registry.plugins) {
    if (!record.skills || record.skills.length === 0) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.config,
      enabledByDefault: record.enabledByDefault,
    });
    if (!activationState.activated) {
      continue;
    }
    // ACP router skills should not be attached unless ACP can actually spawn.
    if (!acpRuntimeAvailable && record.id === "acpx") {
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
    for (const raw of record.skills) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (!fs.existsSync(candidate)) {
        log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
        continue;
      }
      if (!isPathInsideWithRealpath(record.rootDir, candidate, { requireRealpath: true })) {
        log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
        continue;
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      resolved.push(candidate);
    }
  }

  return resolved;
}
