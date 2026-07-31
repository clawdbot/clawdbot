import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { registerContextEngineForOwner } from "../context-engine/registry.js";
import {
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime-state.js";
import {
  getRegisteredCompactionProvider,
  registerCompactionProvider as registerGlobalCompactionProvider,
} from "./compaction-provider.js";
import { registerRegistryPluginInteractiveHandler } from "./interactive-registry.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { defaultSlotIdForKey } from "./slots.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "./types.js";

export function createCapabilityRegistrars(state: PluginRegistryState) {
  const { registry, pushDiagnostic } = state;

  const registerDetachedTaskRuntime = (
    record: PluginRecord,
    runtime: Parameters<OpenClawPluginApi["registerDetachedTaskRuntime"]>[0],
  ) => {
    const existing = getDetachedTaskLifecycleRuntimeRegistration();
    if (existing && existing.pluginId !== record.id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `detached task runtime already registered by ${existing.pluginId}`,
      });
      return;
    }
    registerDetachedTaskLifecycleRuntime(record.id, runtime);
  };

  const registerInteractiveHandler = (
    record: PluginRecord,
    registration: Parameters<OpenClawPluginApi["registerInteractiveHandler"]>[0],
  ) => {
    const result = registerRegistryPluginInteractiveHandler(record.id, registration, {
      pluginName: record.name,
      pluginRoot: record.rootDir,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: result.error ?? "interactive handler registration failed",
      });
      return;
    }
    registry.interactiveHandlers.push({
      ...registration,
      pluginId: record.id,
      pluginName: record.name,
      pluginRoot: record.rootDir,
    });
  };

  const registerContextEngine = (
    record: PluginRecord,
    id: Parameters<OpenClawPluginApi["registerContextEngine"]>[0],
    factory: Parameters<OpenClawPluginApi["registerContextEngine"]>[1],
    registrationMode: PluginRegistrationMode,
  ) => {
    const normalizedId = normalizeOptionalString(id) ?? "";
    if (!normalizedId) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "context engine registration missing id",
      });
      return;
    }
    if (typeof factory !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `context engine "${normalizedId}" registration missing factory`,
      });
      return;
    }
    if (normalizedId === defaultSlotIdForKey("contextEngine")) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `context engine id reserved by core: ${normalizedId}`,
      });
      return;
    }
    const result = registerContextEngineForOwner(normalizedId, factory, `plugin:${record.id}`, {
      allowSameOwnerRefresh: true,
      lifecycle: registrationMode === "full" ? "runtime" : "readOnlyDiscovery",
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `context engine already registered: ${normalizedId} (${result.existingOwner})`,
      });
      return;
    }
    if (!record.contextEngineIds?.includes(normalizedId)) {
      record.contextEngineIds = [...(record.contextEngineIds ?? []), normalizedId];
    }
  };

  const registerCompactionProvider = (
    record: PluginRecord,
    provider: Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0],
  ) => {
    const id = normalizeOptionalString(
      (provider as Partial<Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0]> | null)
        ?.id,
    );
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "compaction provider registration missing id",
      });
      return;
    }
    if (typeof provider?.summarize !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `compaction provider "${id}" registration missing summarize`,
      });
      return;
    }
    const existing = getRegisteredCompactionProvider(id);
    if (existing) {
      const ownerDetail = existing.ownerPluginId ? ` (owner: ${existing.ownerPluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `compaction provider already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    registerGlobalCompactionProvider(provider, { ownerPluginId: record.id });
  };

  return {
    registerDetachedTaskRuntime,
    registerInteractiveHandler,
    registerContextEngine,
    registerCompactionProvider,
  };
}
