import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { hasKind } from "./slots.js";
import type { OpenClawPluginApi } from "./types.js";

export function createMemoryRegistrars(state: PluginRegistryState) {
  const { registry, pushDiagnostic } = state;

  const requireMemorySlot = (record: PluginRecord, surface: string): boolean => {
    if (!hasKind(record.kind, "memory")) {
      throw new Error(`only memory plugins can register a memory ${surface}`);
    }
    if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `dual-kind plugin not selected for memory slot; skipping memory ${surface} registration`,
      });
      return false;
    }
    return true;
  };

  const registerMemoryCapability = (
    record: PluginRecord,
    capability: Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0],
  ) => {
    if (requireMemorySlot(record, "capability")) {
      registry.memoryCapabilities.push({ pluginId: record.id, capability });
    }
  };

  const registerMemoryPromptSupplement = (
    record: PluginRecord,
    builder: Parameters<OpenClawPluginApi["registerMemoryPromptSupplement"]>[0],
  ) => {
    if (typeof builder !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "memory prompt supplement registration missing builder",
      });
      return;
    }
    registry.memoryPromptSupplements = registry.memoryPromptSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptSupplements.push({ pluginId: record.id, builder });
  };

  const registerMemoryPromptPreparation = (
    record: PluginRecord,
    prepare: Parameters<OpenClawPluginApi["registerMemoryPromptPreparation"]>[0],
  ) => {
    if (typeof prepare !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "memory prompt preparation registration missing prepare function",
      });
      return;
    }
    registry.memoryPromptPreparations = registry.memoryPromptPreparations.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptPreparations.push({ pluginId: record.id, prepare });
  };

  const registerMemoryCorpusSupplement = (
    record: PluginRecord,
    supplement: Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0],
  ) => {
    registry.memoryCorpusSupplements = registry.memoryCorpusSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryCorpusSupplements.push({ pluginId: record.id, supplement });
  };

  const registerMemoryEmbeddingProvider = (
    record: PluginRecord,
    adapter: Parameters<OpenClawPluginApi["registerMemoryEmbeddingProvider"]>[0],
  ) => {
    if (hasKind(record.kind, "memory")) {
      if (!requireMemorySlot(record, "embedding provider")) {
        return;
      }
    } else if (!(record.contracts?.memoryEmbeddingProviders ?? []).includes(adapter.id)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: ${adapter.id}`,
      });
      return;
    }
    const existing = registry.memoryEmbeddingProviders.find(
      (entry) => entry.provider.id === adapter.id,
    );
    if (existing) {
      const ownerDetail = existing.pluginId ? ` (owner: ${existing.pluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `memory embedding provider already registered: ${adapter.id}${ownerDetail}`,
      });
      return;
    }
    registry.memoryEmbeddingProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: adapter,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  return {
    registerMemoryCapability,
    registerMemoryPromptSupplement,
    registerMemoryPromptPreparation,
    registerMemoryCorpusSupplement,
    registerMemoryEmbeddingProvider,
  };
}
