import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { hasKind } from "../plugins/slots.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";

const log = createSubsystemLogger("hooks");

export type PluginHookDirEntry = {
  dir: string;
  pluginId: string;
};

export function resolvePluginHookDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): PluginHookDirEntry[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return [];
  }
  const registry = loadPluginManifestRegistry({
    workspaceDir,
    config: params.config,
    // Hook discovery should reflect freshly written bundle manifests immediately.
    cache: false,
  });
  if (registry.plugins.length === 0) {
    return [];
  }

  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const seen = new Set<string>();
  const resolved: PluginHookDirEntry[] = [];

  for (const record of registry.plugins) {
    if (!record.hooks || record.hooks.length === 0) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.config,
    });
    if (!activationState.activated) {
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

    for (const raw of record.hooks) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (!fs.existsSync(candidate)) {
        log.warn(`plugin hook path not found (${record.id}): ${candidate}`);
        continue;
      }
      if (!isPathInsideWithRealpath(record.rootDir, candidate, { requireRealpath: true })) {
        log.warn(`plugin hook path escapes plugin root (${record.id}): ${candidate}`);
        continue;
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      resolved.push({
        dir: candidate,
        pluginId: record.id,
      });
    }
  }

  return resolved;
}
