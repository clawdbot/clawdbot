import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
import { registerPluginInteractiveHandlerInRegistry } from "./interactive-registry.js";
import type { BrowserNodeDelegation } from "./registry-contribution-types.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { defaultSlotIdForKey } from "./slots.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "./types.js";

export function createCapabilityRegistrars(state: PluginRegistryState) {
  const { registry, pushDiagnostic } = state;

  const isTrustedBrowserPluginRecord = (record: PluginRecord) =>
    record.origin === "bundled" || record.trustedOfficialInstall === true;

  const registerBrowserNodeDelegation = (
    record: PluginRecord,
    delegation: BrowserNodeDelegation,
  ) => {
    if (record.id !== "browser") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "browser node delegation may only be registered by the browser plugin",
      });
      return;
    }
    if (!isTrustedBrowserPluginRecord(record)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "browser node delegation requires a trusted Browser plugin record",
      });
      return;
    }
    const consumerPluginIds = delegation.consumerPluginIds
      .filter((pluginId): pluginId is string => typeof pluginId === "string")
      .map((pluginId) => pluginId.trim())
      .filter(Boolean);
    if (consumerPluginIds.length === 0 || typeof delegation.request !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "browser node delegation requires consumers and a request handler",
      });
      return;
    }
    registry.browserNodeDelegations = [
      ...registry.browserNodeDelegations.filter((entry) => entry.pluginId !== record.id),
      {
        pluginId: record.id,
        providerRecord: record,
        provider: {
          origin: record.origin,
          source: record.source,
          ...(record.rootDir ? { rootDir: record.rootDir } : {}),
          ...(record.trustedOfficialInstall !== undefined
            ? { trustedOfficialInstall: record.trustedOfficialInstall }
            : {}),
        },
        delegation: {
          consumerPluginIds: [...new Set(consumerPluginIds)],
          request: delegation.request,
        },
      },
    ];
  };

  const registerDetachedTaskRuntime = (
    record: PluginRecord,
    runtime: Parameters<OpenClawPluginApi["registerDetachedTaskRuntime"]>[0],
  ) => {
    const existing = registry.detachedTaskRuntimes[0];
    if (existing && existing.pluginId !== record.id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `detached task runtime already registered by ${existing.pluginId}`,
      });
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
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: result.error ?? "interactive handler registration failed",
      });
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
    const existing = registry.compactionProviders.find((entry) => entry.provider.id === id);
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
    registry.compactionProviders.push({ provider, ownerPluginId: record.id });
  };

  return {
    registerBrowserNodeDelegation,
    registerDetachedTaskRuntime,
    registerInteractiveHandler,
    registerContextEngine,
    registerCompactionProvider,
  };
}
