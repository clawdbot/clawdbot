import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
import { registerPluginInteractiveHandlerInRegistry } from "./interactive-registry.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { defaultSlotIdForKey } from "./slots.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "./types.js";

export function createCapabilityRegistrars(state: PluginRegistryState) {
  const { registry, reportRegistrationError, reportRegistrationWarning } = state;

  const registerDetachedTaskRuntime = (
    record: PluginRecord,
    runtime: Parameters<OpenClawPluginApi["registerDetachedTaskRuntime"]>[0],
  ) => {
    const existing = registry.detachedTaskRuntimes[0];
    if (existing && existing.pluginId !== record.id) {
      reportRegistrationError(
        record,
        `detached task runtime already registered by ${existing.pluginId}`,
      );
      return;
    }
    const next = { pluginId: record.id, runtime };
    if (existing) {
      registry.detachedTaskRuntimes.splice(0, 1, next);
    } else {
      registry.detachedTaskRuntimes.push(next);
    }
  };

  const registerInteractiveHandler = (
    record: PluginRecord,
    registration: Parameters<OpenClawPluginApi["registerInteractiveHandler"]>[0],
  ) => {
    const result = registerPluginInteractiveHandlerInRegistry(registry, record.id, registration, {
      pluginName: record.name,
      pluginRoot: record.rootDir,
    });
    if (!result.ok) {
      reportRegistrationWarning(record, result.error ?? "interactive handler registration failed");
    }
  };

  const registerContextEngine = (
    record: PluginRecord,
    id: Parameters<OpenClawPluginApi["registerContextEngine"]>[0],
    factory: Parameters<OpenClawPluginApi["registerContextEngine"]>[1],
    registrationMode: PluginRegistrationMode,
  ) => {
    const normalizedId = normalizeOptionalString(id) ?? "";
    if (!normalizedId) {
      reportRegistrationError(record, "context engine registration missing id");
      return;
    }
    if (typeof factory !== "function") {
      reportRegistrationError(
        record,
        `context engine "${normalizedId}" registration missing factory`,
      );
      return;
    }
    if (normalizedId === defaultSlotIdForKey("contextEngine")) {
      reportRegistrationError(record, `context engine id reserved by core: ${normalizedId}`);
      return;
    }
    const result = registerContextEngineInRegistry(
      registry,
      normalizedId,
      factory,
      `plugin:${record.id}`,
      {
        allowSameOwnerRefresh: true,
        lifecycle: registrationMode === "full" ? "runtime" : "readOnlyDiscovery",
      },
    );
    if (!result.ok) {
      reportRegistrationError(
        record,
        `context engine already registered: ${normalizedId} (${result.existingOwner})`,
      );
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
      reportRegistrationError(record, "compaction provider registration missing id");
      return;
    }
    if (typeof provider?.summarize !== "function") {
      reportRegistrationError(record, `compaction provider "${id}" registration missing summarize`);
      return;
    }
    const existing = registry.compactionProviders.find((entry) => entry.provider.id === id);
    if (existing) {
      const ownerDetail = existing.ownerPluginId ? ` (owner: ${existing.ownerPluginId})` : "";
      reportRegistrationError(
        record,
        `compaction provider already registered: ${id}${ownerDetail}`,
      );
      return;
    }
    registry.compactionProviders.push({ provider, ownerPluginId: record.id });
  };

  return {
    registerDetachedTaskRuntime,
    registerInteractiveHandler,
    registerContextEngine,
    registerCompactionProvider,
  };
}
