import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import type { PluginCompatCode } from "./compat/registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import {
  buildPluginShapeSummary,
  type PluginCapabilityEntry,
  type PluginInspectShape,
} from "./inspect-shape.js";
import { loadOpenClawPlugins } from "./loader.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import {
  loadPluginRegistrySnapshotWithMetadata,
  type PluginRegistrySnapshotDiagnostic,
  type PluginRegistrySnapshotSource,
} from "./plugin-registry.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import { createEmptyPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { loadPluginMetadataRegistrySnapshot } from "./runtime/metadata-registry-loader.js";
import type { PluginHookName, PluginLogger } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

export type PluginRegistryStatusReport = PluginStatusReport & {
  registrySource: PluginRegistrySnapshotSource;
  registryDiagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};

export type { PluginCapabilityKind, PluginInspectShape } from "./inspect-shape.js";

export type PluginCompatibilityNotice = {
  pluginId: string;
  code: "legacy-before-agent-start" | "legacy-implicit-startup-sidecar" | "hook-only";
  compatCode: PluginCompatCode;
  severity: "warn" | "info";
  message: string;
};

export type PluginCompatibilitySummary = {
  noticeCount: number;
  pluginCount: number;
};

export type PluginInspectReport = {
  workspaceDir?: string;
  plugin: PluginRegistry["plugins"][number];
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: PluginCapabilityEntry[];
  typedHooks: Array<{
    name: PluginHookName;
    priority?: number;
  }>;
  customHooks: Array<{
    name: string;
    events: string[];
  }>;
  tools: Array<{
    names: string[];
    optional: boolean;
  }>;
  commands: string[];
  cliCommands: string[];
  services: string[];
  gatewayDiscoveryServices: string[];
  gatewayMethods: string[];
  mcpServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  lspServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  httpRouteCount: number;
  bundleCapabilities: string[];
  diagnostics: PluginDiagnostic[];
  policy: {
    allowPromptInjection?: boolean;
    allowConversationAccess?: boolean;
    allowModelOverride?: boolean;
    allowedModels: string[];
    hasAllowedModelsConfig: boolean;
  };
  usesLegacyBeforeAgentStart: boolean;
  compatibility: PluginCompatibilityNotice[];
};

function buildCompatibilityNoticesForInspect(
  inspect: Pick<PluginInspectReport, "plugin" | "shape" | "usesLegacyBeforeAgentStart">,
): PluginCompatibilityNotice[] {
  const warnings: PluginCompatibilityNotice[] = [];
  if (inspect.usesLegacyBeforeAgentStart) {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "legacy-before-agent-start",
      compatCode: "legacy-before-agent-start",
      severity: "warn",
      message:
        "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
    });
  }
  if (inspect.plugin.compat?.includes("legacy-implicit-startup-sidecar")) {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "legacy-implicit-startup-sidecar",
      compatCode: "legacy-implicit-startup-sidecar",
      severity: "warn",
      message:
        "relies on deprecated implicit startup loading; add activation.onStartup: true for startup work or activation.onStartup: false for startup-lazy plugins.",
    });
  }
  if (inspect.shape === "hook-only") {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "hook-only",
      compatCode: "hook-only-plugin-shape",
      severity: "info",
      message:
        "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
    });
  }
  return warnings;
}

function resolveReportedPluginVersion(
  plugin: PluginRegistry["plugins"][number],
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (plugin.origin !== "bundled") {
    return plugin.version;
  }
  return (
    normalizeOpenClawVersionBase(resolveCompatibilityHostVersion(env)) ??
    normalizeOpenClawVersionBase(plugin.version) ??
    plugin.version
  );
}

type PluginReportParams = {
  config?: OpenClawConfig;
  effectiveOnly?: boolean;
  onlyPluginIds?: readonly string[];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
};

function buildPluginRecordFromInstalledIndex(
  plugin: import("./installed-plugin-index.js").InstalledPluginIndexRecord,
  manifest?: PluginManifestRecord,
): PluginRecord {
  const format = plugin.format ?? manifest?.format ?? "openclaw";
  const bundleFormat = plugin.bundleFormat ?? manifest?.bundleFormat;
  return {
    id: plugin.pluginId,
    name: manifest?.name ?? plugin.packageName ?? plugin.pluginId,
    ...(plugin.packageVersion || manifest?.version
      ? { version: plugin.packageVersion ?? manifest?.version }
      : {}),
    ...(manifest?.description ? { description: manifest.description } : {}),
    format,
    ...(bundleFormat ? { bundleFormat } : {}),
    ...(manifest?.kind ? { kind: manifest.kind } : {}),
    source: plugin.source ?? plugin.manifestPath,
    rootDir: plugin.rootDir,
    origin: plugin.origin,
    enabled: plugin.enabled,
    compat: plugin.compat,
    syntheticAuthRefs: [...(plugin.syntheticAuthRefs ?? manifest?.syntheticAuthRefs ?? [])],
    status: plugin.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [...(manifest?.channels ?? [])],
    cliBackendIds: [...(manifest?.cliBackends ?? []), ...(manifest?.setup?.cliBackends ?? [])],
    providerIds: [...(manifest?.providers ?? [])],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [...(manifest?.commandAliases?.map((alias) => alias.name) ?? [])],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
    contracts: {},
  };
}

export function buildPluginRegistrySnapshotReport(
  params?: PluginReportParams,
): PluginRegistryStatusReport {
  const config = params?.config ?? getRuntimeConfig();
  const result = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () =>
      loadPluginRegistrySnapshotWithMetadata({
        config,
        env: params?.env,
        workspaceDir: params?.workspaceDir,
      }),
    { surface: "status" },
  );
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index: result.snapshot,
    config,
    env: params?.env,
    workspaceDir: params?.workspaceDir,
    includeDisabled: true,
  });
  const manifestByPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
  return {
    workspaceDir: params?.workspaceDir,
    ...createEmptyPluginRegistry(),
    plugins: result.snapshot.plugins.map((plugin) =>
      buildPluginRecordFromInstalledIndex(plugin, manifestByPluginId.get(plugin.pluginId)),
    ),
    diagnostics: [...result.snapshot.diagnostics],
    registrySource: result.source,
    registryDiagnostics: result.diagnostics,
  };
}

function buildPluginReport(
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const baseContext = resolvePluginRuntimeLoadContext({
    config: params?.config ?? getRuntimeConfig(),
    env: params?.env,
    logger: params?.logger,
    workspaceDir: params?.workspaceDir,
  });
  const workspaceDir = baseContext.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const context =
    workspaceDir === baseContext.workspaceDir
      ? baseContext
      : {
          ...baseContext,
          workspaceDir,
        };
  const rawConfig = context.rawConfig;
  const config = context.config;

  // Apply bundled-provider allowlist compat so that `plugins list` and `doctor`
  // report the same loaded/disabled status the gateway uses at runtime.  Without
  // this, bundled provider plugins are incorrectly shown as "disabled" when
  // `plugins.allow` is set because the allowlist check runs before the
  // bundled-default-enable check.  Scoped to bundled providers only (not all
  // bundled plugins) to match the runtime compat surface in providers.runtime.ts.
  const bundledProviderIds = resolveBundledProviderCompatPluginIds({
    config,
    workspaceDir,
    env: params?.env,
  });
  const effectiveConfig = withBundledPluginAllowlistCompat({
    config,
    pluginIds: bundledProviderIds,
  });
  const runtimeCompatConfig = withBundledPluginEnablementCompat({
    config: effectiveConfig,
    pluginIds: bundledProviderIds,
  });
  const onlyPluginIds =
    params?.effectiveOnly === true
      ? resolveEffectivePluginIds({
          config: rawConfig,
          workspaceDir,
          env: params?.env ?? process.env,
        })
      : params?.onlyPluginIds === undefined
        ? undefined
        : [...params.onlyPluginIds];

  const registry = loadModules
    ? tracePluginLifecyclePhase(
        "runtime plugin registry load",
        () =>
          loadOpenClawPlugins(
            buildPluginRuntimeLoadOptions(context, {
              config: runtimeCompatConfig,
              activationSourceConfig: rawConfig,
              workspaceDir,
              env: params?.env,
              loadModules,
              activate: false,
              cache: false,
              onlyPluginIds,
            }),
          ),
        { surface: "status", onlyPluginCount: onlyPluginIds?.length },
      )
    : tracePluginLifecyclePhase(
        "plugin registry snapshot",
        () =>
          loadPluginMetadataRegistrySnapshot({
            config: runtimeCompatConfig,
            activationSourceConfig: rawConfig,
            workspaceDir,
            env: params?.env,
            logger: params?.logger,
            loadModules: false,
            onlyPluginIds,
          }),
        { surface: "status", onlyPluginCount: onlyPluginIds?.length },
      );
  const importedPluginIds = new Set([
    ...(loadModules
      ? registry.plugins
          .filter((plugin) => plugin.status === "loaded" && plugin.format !== "bundle")
          .map((plugin) => plugin.id)
      : []),
    ...listImportedRuntimePluginIds(),
    ...listImportedBundledPluginFacadeIds(),
  ]);

  return {
    workspaceDir,
    ...registry,
    plugins: registry.plugins.map((plugin) =>
      Object.assign({}, plugin, {
        imported: plugin.format !== `bundle` && importedPluginIds.has(plugin.id),
        version: resolveReportedPluginVersion(plugin, params?.env),
      }),
    ),
  };
}

export function buildPluginSnapshotReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, false);
}

export function buildPluginDiagnosticsReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, true);
}

export function buildPluginInspectReport(params: {
  id: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
}): PluginInspectReport | null {
  const rawConfig = params.config ?? getRuntimeConfig();
  const config = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params.env,
    logger: params.logger,
    workspaceDir: params.workspaceDir,
  }).config;
  const report =
    params.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      logger: params.logger,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const plugin = report.plugins.find((entry) => entry.id === params.id || entry.name === params.id);
  if (!plugin) {
    return null;
  }

  const typedHooks = report.typedHooks
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      name: entry.hookName,
      priority: entry.priority,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const customHooks = report.hooks
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      name: entry.entry.hook.name,
      events: [...entry.events].toSorted(),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const tools = report.tools
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      names: [...entry.names],
      optional: entry.optional,
    }));
  const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === plugin.id);
  const policyEntry = normalizePluginsConfig(config.plugins).entries[plugin.id];
  const shapeSummary = buildPluginShapeSummary({ plugin, report });
  const shape = shapeSummary.shape;

  // Populate MCP server info for bundle-format plugins with a known rootDir.
  let mcpServers: PluginInspectReport["mcpServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const mcpSupport = inspectBundleMcpRuntimeSupport({
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
      bundleFormat: plugin.bundleFormat,
    });
    mcpServers = [
      ...mcpSupport.supportedServerNames.map((name) => ({
        name,
        hasStdioTransport: true,
      })),
      ...mcpSupport.unsupportedServerNames.map((name) => ({
        name,
        hasStdioTransport: false,
      })),
    ];
  }

  // Populate LSP server info for bundle-format plugins with a known rootDir.
  let lspServers: PluginInspectReport["lspServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const lspSupport = inspectBundleLspRuntimeSupport({
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
      bundleFormat: plugin.bundleFormat,
    });
    lspServers = [
      ...lspSupport.supportedServerNames.map((name) => ({
        name,
        hasStdioTransport: true,
      })),
      ...lspSupport.unsupportedServerNames.map((name) => ({
        name,
        hasStdioTransport: false,
      })),
    ];
  }

  const usesLegacyBeforeAgentStart = shapeSummary.usesLegacyBeforeAgentStart;
  const compatibility = buildCompatibilityNoticesForInspect({
    plugin,
    shape,
    usesLegacyBeforeAgentStart,
  });
  return {
    workspaceDir: report.workspaceDir,
    plugin,
    shape,
    capabilityMode: shapeSummary.capabilityMode,
    capabilityCount: shapeSummary.capabilityCount,
    capabilities: shapeSummary.capabilities,
    typedHooks,
    customHooks,
    tools,
    commands: [...plugin.commands],
    cliCommands: [...plugin.cliCommands],
    services: [...plugin.services],
    gatewayDiscoveryServices: [...plugin.gatewayDiscoveryServiceIds],
    gatewayMethods: [...plugin.gatewayMethods],
    mcpServers,
    lspServers,
    httpRouteCount: plugin.httpRoutes,
    bundleCapabilities: plugin.bundleCapabilities ?? [],
    diagnostics,
    policy: {
      allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
      allowConversationAccess: policyEntry?.hooks?.allowConversationAccess,
      allowModelOverride: policyEntry?.subagent?.allowModelOverride,
      allowedModels: [...(policyEntry?.subagent?.allowedModels ?? [])],
      hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true,
    },
    usesLegacyBeforeAgentStart,
    compatibility,
  };
}

export function buildAllPluginInspectReports(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
}): PluginInspectReport[] {
  const rawConfig = params?.config ?? getRuntimeConfig();
  const report =
    params?.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      logger: params?.logger,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
    });

  return report.plugins
    .map((plugin) =>
      buildPluginInspectReport({
        id: plugin.id,
        config: rawConfig,
        logger: params?.logger,
        report,
      }),
    )
    .filter((entry): entry is PluginInspectReport => entry !== null);
}

export function buildPluginCompatibilityWarnings(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
}): string[] {
  return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}

export function buildPluginCompatibilityNotices(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
}): PluginCompatibilityNotice[] {
  return buildAllPluginInspectReports(params).flatMap((inspect) => inspect.compatibility);
}

export function buildPluginCompatibilitySnapshotNotices(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginCompatibilityNotice[] {
  const report = buildPluginSnapshotReport(params);
  return buildPluginCompatibilityNotices({
    ...params,
    report,
  });
}

export function formatPluginCompatibilityNotice(notice: PluginCompatibilityNotice): string {
  return `${notice.pluginId} ${notice.message}`;
}

export function summarizePluginCompatibility(
  notices: PluginCompatibilityNotice[],
): PluginCompatibilitySummary {
  return {
    noticeCount: notices.length,
    pluginCount: new Set(notices.map((notice) => notice.pluginId)).size,
  };
}
