import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { hasKind } from "./slots.js";
import type { OpenClawPluginApi } from "./types.js";

export function createMemoryRegistrars(state: PluginRegistryState) {
  const { registry, reportRegistrationError, reportRegistrationWarning } = state;

  const requireMemorySlot = (record: PluginRecord, surface: string): boolean => {
    if (!hasKind(record.kind, "memory")) {
      throw new Error(`only memory plugins can register a memory ${surface}`);
    }
    if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
      reportRegistrationWarning(
        record,
        `dual-kind plugin not selected for memory slot; skipping memory ${surface} registration`,
      );
      return false;
    }
    return true;
  };

  const registerMemoryCapability = (
    record: PluginRecord,
    capability: Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0],
  ) => {
    if (!requireMemorySlot(record, "capability")) {
      return;
    }
    // Dreaming keeps an unselected sidecar active for consolidation. Strip its
    // slot-owner fields so resolution cannot lend its runtime or recall grant.
    const memorySlotSelected = record.memorySlotSelected === true;
    const dropsSlotOwnerFacts =
      !memorySlotSelected &&
      (capability.runtime !== undefined ||
        capability.deterministicRecallToolName !== undefined ||
        capability.supportsPrivateTranscriptRecall !== undefined);
    if (dropsSlotOwnerFacts) {
      reportRegistrationWarning(
        record,
        "memory plugin not selected for the memory slot; skipping its indexing runtime and recall registration (consolidation lifecycle preserved)",
      );
    }
    const {
      runtime: _droppedRuntime,
      deterministicRecallToolName: _droppedRecallToolName,
      supportsPrivateTranscriptRecall: _droppedPrivateRecall,
      ...consolidationCapability
    } = capability;
    registry.memoryCapabilities.push({
      pluginId: record.id,
      capability: memorySlotSelected ? capability : consolidationCapability,
      memorySlotSelected,
    });
  };

  const registerMemoryPromptSupplement = (
    record: PluginRecord,
    builder: Parameters<OpenClawPluginApi["registerMemoryPromptSupplement"]>[0],
  ) => {
    if (typeof builder !== "function") {
      reportRegistrationError(record, "memory prompt supplement registration missing builder");
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
      reportRegistrationError(
        record,
        "memory prompt preparation registration missing prepare function",
      );
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

  return {
    registerMemoryCapability,
    registerMemoryPromptSupplement,
    registerMemoryPromptPreparation,
    registerMemoryCorpusSupplement,
  };
}
