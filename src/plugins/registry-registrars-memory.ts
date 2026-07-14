import {
  getRegisteredMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider as registerGlobalMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  registerMemoryCapability as registerGlobalMemoryCapability,
  registerMemoryCorpusSupplement as registerGlobalMemoryCorpusSupplement,
  registerMemoryFlushPlanResolverForPlugin,
  registerMemoryPromptSupplement as registerGlobalMemoryPromptSupplement,
  registerMemoryPromptSectionForPlugin,
  registerMemoryRuntimeForPlugin,
} from "./memory-state.js";
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
      registerGlobalMemoryCapability(record.id, capability);
    }
  };

  const registerMemoryPromptSection = (
    record: PluginRecord,
    builder: Parameters<OpenClawPluginApi["registerMemoryPromptSection"]>[0],
  ) => {
    if (requireMemorySlot(record, "prompt section")) {
      registerMemoryPromptSectionForPlugin(record.id, builder);
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
    registerGlobalMemoryPromptSupplement(record.id, builder);
  };

  const registerMemoryCorpusSupplement = (
    record: PluginRecord,
    supplement: Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0],
  ) => {
    registerGlobalMemoryCorpusSupplement(record.id, supplement);
  };

  const registerMemoryFlushPlan = (
    record: PluginRecord,
    resolver: Parameters<OpenClawPluginApi["registerMemoryFlushPlan"]>[0],
  ) => {
    if (requireMemorySlot(record, "flush plan")) {
      registerMemoryFlushPlanResolverForPlugin(record.id, resolver);
    }
  };

  const registerMemoryRuntime = (
    record: PluginRecord,
    runtime: Parameters<OpenClawPluginApi["registerMemoryRuntime"]>[0],
  ) => {
    if (requireMemorySlot(record, "runtime")) {
      registerMemoryRuntimeForPlugin(record.id, runtime);
    }
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
    const existing = getRegisteredMemoryEmbeddingProvider(adapter.id);
    if (existing) {
      const ownerDetail = existing.ownerPluginId ? ` (owner: ${existing.ownerPluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `memory embedding provider already registered: ${adapter.id}${ownerDetail}`,
      });
      return;
    }
    registerGlobalMemoryEmbeddingProvider(adapter, { ownerPluginId: record.id });
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
    registerMemoryPromptSection,
    registerMemoryPromptSupplement,
    registerMemoryCorpusSupplement,
    registerMemoryFlushPlan,
    registerMemoryRuntime,
    registerMemoryEmbeddingProvider,
  };
}
