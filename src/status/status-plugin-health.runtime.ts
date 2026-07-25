import { listPersistedRuntimeToolSchemaQuarantines } from "../agents/tool-schema-quarantine-health.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
// Runtime plugin health collection is isolated from pure status formatting so
// ordinary status tests do not eagerly load plugin registry internals.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listContextEngineQuarantines } from "../context-engine/registry.js";
import {
  getActiveRuntimePluginRegistry,
  listLoadedRuntimePluginIdsAcrossSurfaces,
} from "../plugins/active-runtime-registry.js";
import {
  dedupeChannelPluginFailures,
  dedupePluginDiagnostics,
  isChannelPluginFailureDiagnostic,
  mergeStatusPluginHealthSnapshots,
} from "./status-plugin-health.js";
import type {
  ChannelPluginFailureRecord,
  PluginCompatibilityHealthNotice,
  PluginDiagnosticRecord,
  PluginHealthRecord,
  RuntimeToolQuarantineRecord,
  StatusPluginHealthSnapshot,
} from "./status-plugin-health.js";

// The normalize* helpers project registry records onto the snapshot types while
// omitting absent fields entirely, so snapshot merges never see explicitly
// undefined values and test fixtures stay minimal.
function normalizeSnapshotPlugin(plugin: PluginHealthRecord): PluginHealthRecord {
  const normalized: PluginHealthRecord = { id: plugin.id };
  if (plugin.status !== undefined) {
    normalized.status = plugin.status;
  }
  if (plugin.enabled !== undefined) {
    normalized.enabled = plugin.enabled;
  }
  if (plugin.error !== undefined) {
    normalized.error = plugin.error;
  }
  if (plugin.dependencyStatus !== undefined) {
    normalized.dependencyStatus = plugin.dependencyStatus;
  }
  if (plugin.failurePhase !== undefined) {
    normalized.failurePhase = plugin.failurePhase;
  }
  return normalized;
}

function normalizeDiagnostic(diagnostic: PluginDiagnosticRecord): PluginDiagnosticRecord {
  const normalized: PluginDiagnosticRecord = {
    level: diagnostic.level,
    message: diagnostic.message,
  };
  if (diagnostic.pluginId) {
    normalized.pluginId = diagnostic.pluginId;
  }
  if (diagnostic.code) {
    normalized.code = diagnostic.code;
  }
  return normalized;
}

function normalizeCompatibilityNotice(
  notice: PluginCompatibilityHealthNotice,
): PluginCompatibilityHealthNotice {
  return {
    pluginId: notice.pluginId,
    severity: notice.severity,
    message: notice.message,
    ...(notice.code ? { code: notice.code } : {}),
  };
}

function collectChannelPluginFailures(params: {
  config?: OpenClawConfig;
  diagnostics?: readonly PluginDiagnosticRecord[];
  workspaceDir?: string;
}): ChannelPluginFailureRecord[] {
  const diagnosticFailures = (params.diagnostics ?? [])
    .filter(isChannelPluginFailureDiagnostic)
    .map((diagnostic) => {
      const failure: ChannelPluginFailureRecord = {
        channelId: diagnostic.pluginId ?? "unknown",
        message: diagnostic.message,
        source: "diagnostic",
      };
      if (diagnostic.pluginId) {
        failure.pluginId = diagnostic.pluginId;
      }
      return failure;
    });
  if (!params.config) {
    return dedupeChannelPluginFailures(diagnosticFailures);
  }
  try {
    const resolution = resolveReadOnlyChannelPluginsForConfig(params.config, {
      workspaceDir: params.workspaceDir,
      activationSourceConfig: params.config,
      includePersistedAuthState: false,
      // Detailed status inspects the full surface, including setup-fallback
      // plugins, so missing-channel detection matches what setup would load.
      includeSetupFallbackPlugins: true,
    });
    const loadFailures = resolution.loadFailures.map((failure) => ({
      channelId: failure.channelId,
      pluginId: failure.pluginId,
      message: failure.message,
      ...(failure.source ? { source: failure.source } : {}),
    }));
    const concreteFailures = dedupeChannelPluginFailures([...diagnosticFailures, ...loadFailures]);
    const failedChannelIds = new Set(concreteFailures.map((failure) => failure.channelId));
    return [
      ...concreteFailures,
      ...resolution.missingConfiguredChannelIds
        .filter((channelId) => !failedChannelIds.has(channelId))
        .map((channelId) => ({
          channelId,
          message: "configured channel plugin is missing or unavailable",
        })),
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      ...diagnosticFailures,
      {
        channelId: "unknown",
        message: `failed to inspect configured channel plugins: ${message}`,
      },
    ];
  }
}

function parsePluginOwner(owner: string | undefined): string | undefined {
  const prefix = "plugin:";
  if (!owner?.startsWith(prefix)) {
    return undefined;
  }
  const pluginId = owner.slice(prefix.length).trim();
  return pluginId.length > 0 ? pluginId : undefined;
}

function filterRuntimeToolQuarantinesForRegistry(params: {
  quarantines: readonly RuntimeToolQuarantineRecord[];
  plugins: readonly PluginHealthRecord[];
}): RuntimeToolQuarantineRecord[] {
  const loadedPluginIds = new Set(
    params.plugins
      .filter((plugin) => plugin.enabled !== false && plugin.status !== "disabled")
      .map((plugin) => plugin.id),
  );
  return params.quarantines.filter((quarantine) => {
    const pluginId = parsePluginOwner(quarantine.owner);
    return !pluginId || loadedPluginIds.has(pluginId);
  });
}

// Compact status reads only the active registry and persisted health stores;
// full config-driven channel inspection is reserved for the installed path.
export function collectRuntimePluginHealthSnapshot(): StatusPluginHealthSnapshot {
  const registry = getActiveRuntimePluginRegistry();
  const diagnostics = (registry?.diagnostics ?? []).map(normalizeDiagnostic);
  const plugins = (registry?.plugins ?? []).map(normalizeSnapshotPlugin);
  // Confirmed runtime-loaded ids across all live registry surfaces (so a plugin
  // still live via a pinned channel/http-route registry counts) let detailed
  // status separate actually-loaded plugins from disk-scan inventory the merged
  // snapshot also marks "loaded".
  const runtimeLoadedPluginIds = listLoadedRuntimePluginIdsAcrossSurfaces();
  return {
    plugins,
    diagnostics,
    contextEngineQuarantines: listContextEngineQuarantines(),
    runtimeToolQuarantines: filterRuntimeToolQuarantinesForRegistry({
      quarantines: listPersistedRuntimeToolSchemaQuarantines(),
      plugins,
    }),
    channelPluginFailures: collectChannelPluginFailures({
      diagnostics,
    }),
    runtimeLoadedPluginIds,
  };
}

export async function collectInstalledPluginHealthSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<StatusPluginHealthSnapshot> {
  const { buildPluginCompatibilityNotices, buildPluginSnapshotReport } =
    await import("../plugins/status.js");
  const runtime = collectRuntimePluginHealthSnapshot();
  const report = buildPluginSnapshotReport({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const installedDiagnostics = report.diagnostics.map(normalizeDiagnostic);
  // Channel failures resolve once against the union of installed and runtime
  // diagnostics so missing-channel entries cannot duplicate concrete failures
  // that only one side observed.
  const channelPluginFailures = collectChannelPluginFailures({
    config: params.config,
    diagnostics: dedupePluginDiagnostics([...installedDiagnostics, ...runtime.diagnostics]),
    workspaceDir: params.workspaceDir,
  });
  const runtimeRegistry = getActiveRuntimePluginRegistry();
  const runtimeCompatibilityNotices = runtimeRegistry
    ? buildPluginCompatibilityNotices({
        config: params.config,
        workspaceDir: params.workspaceDir,
        report: runtimeRegistry,
      }).map(normalizeCompatibilityNotice)
    : [];
  const merged = mergeStatusPluginHealthSnapshots(
    {
      plugins: report.plugins.map(normalizeSnapshotPlugin),
      diagnostics: installedDiagnostics,
      contextEngineQuarantines: [],
      channelPluginFailures,
      compatibilityNotices: buildPluginCompatibilityNotices({
        config: params.config,
        workspaceDir: params.workspaceDir,
        report,
      }).map(normalizeCompatibilityNotice),
    },
    { ...runtime, compatibilityNotices: runtimeCompatibilityNotices },
  );
  const shouldRunPluginIds = await resolveEagerShouldRunPluginIds(params);
  const unregisteredMemoryEmbeddingProviders = await resolveUnregisteredMemoryEmbeddingProviders({
    config: params.config,
    registry: runtimeRegistry,
  });
  return {
    ...merged,
    ...(shouldRunPluginIds ? { shouldRunPluginIds } : {}),
    ...(unregisteredMemoryEmbeddingProviders ? { unregisteredMemoryEmbeddingProviders } : {}),
  };
}

// Configured memory embedding providers that no loaded plugin registers, surfaced on the
// detailed /status path only. Needs the live runtime registry to know what a loaded plugin
// actually serves; without config or an active registry we cannot tell "configured but
// unavailable" from "not yet loaded", so degrade to no signal (no line). Resolved lazily so
// the compact path never pulls the startup-plan module. Observer-only: any resolution failure
// degrades to no set rather than breaking /status.
async function resolveUnregisteredMemoryEmbeddingProviders(params: {
  config?: OpenClawConfig;
  registry: ReturnType<typeof getActiveRuntimePluginRegistry>;
}): Promise<Array<{ configuredId: string; source: "provider" | "fallback" }> | undefined> {
  if (!params.config || !params.registry) {
    return undefined;
  }
  try {
    const {
      collectRegisteredEmbeddingProviderIds,
      collectUnregisteredConfiguredMemoryEmbeddingProviders,
    } = await import("../plugins/gateway-startup-plugin-ids.js");
    const unregistered = collectUnregisteredConfiguredMemoryEmbeddingProviders({
      config: params.config,
      registeredProviderIds: collectRegisteredEmbeddingProviderIds(params.registry),
    });
    return unregistered.length > 0 ? unregistered : undefined;
  } catch {
    return undefined;
  }
}

// Eager should-run plugin ids from the gateway startup plan, with deferred channel
// plugins removed: their full load completes only after the gateway starts listening,
// so they would be benign mid-startup false positives in the runtime-loaded drift
// comparison. Detailed-status only and resolved lazily so the compact path never pulls
// the startup-plan module. Observer-only: any resolution failure (or absent config)
// degrades to no should-run set rather than breaking /status.
async function resolveEagerShouldRunPluginIds(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<string[] | undefined> {
  if (!params.config) {
    return undefined;
  }
  try {
    const { loadGatewayStartupPluginPlan } =
      await import("../plugins/gateway-startup-plugin-ids.js");
    const { resolvePluginActivationSourceConfig } =
      await import("../plugins/activation-source-config.js");
    const { resolveGatewayStartupPluginActivationConfig } =
      await import("../gateway/plugin-activation-runtime-config.js");
    // Build the should-run plan with the exact assembly gateway boot uses, via the shared
    // resolveGatewayStartupPluginActivationConfig helper. params.config is the live runtime
    // snapshot; resolvePluginActivationSourceConfig maps it back to the operator source config
    // the loader activates against, then the helper auto-enables that source and merges it into
    // the runtime config (preserving runtime/defaulted fields). Reusing gateway boot's own helper
    // keeps this set from drifting from prepareGatewayPluginBootstrap's plan.
    const sourceConfig = resolvePluginActivationSourceConfig({ config: params.config });
    const effectiveConfig = resolveGatewayStartupPluginActivationConfig({
      runtimeConfig: params.config,
      activationSourceConfig: sourceConfig,
      env: process.env,
    });
    const plan = loadGatewayStartupPluginPlan({
      config: effectiveConfig,
      activationSourceConfig: sourceConfig,
      env: process.env,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    });
    const deferred = new Set(plan.configuredDeferredChannelPluginIds);
    return plan.pluginIds.filter((id) => !deferred.has(id));
  } catch {
    return undefined;
  }
}
