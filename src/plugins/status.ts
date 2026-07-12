// Builds plugin status snapshots for CLI and diagnostics.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import type { PluginCompatCode } from "./compat/registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import {
  buildPluginShapeSummary,
  type PluginCapabilityEntry,
  type PluginInspectShape,
} from "./inspect-shape.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import type { PluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { loadPluginMetadataRegistrySnapshot } from "./runtime/metadata-registry-loader.js";
import { buildPluginDependencyStatus } from "./status-dependencies-core.js";
import type { PluginHookName, PluginLogger } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

export {
  buildPluginRegistrySnapshotReport,
  type PluginRegistryStatusReport,
} from "./status-snapshot.js";
export type { PluginCapabilityKind, PluginInspectShape } from "./inspect-shape.js";

export type PluginCompatibilityNotice = {
  pluginId: string;
  code:
    | "legacy-before-agent-start"
    | "hook-only"
    | "deprecated-memory-embedding-provider-api"
    | "removed-session-transcript-file-api";
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
    hookTimeoutMs?: number;
    hookTimeouts?: Record<string, number>;
    allowModelOverride?: boolean;
    allowedModels: string[];
    hasAllowedModelsConfig: boolean;
  };
  usesLegacyBeforeAgentStart: boolean;
  compatibility: PluginCompatibilityNotice[];
};

function buildCompatibilityNoticesForInspect(
  inspect: Pick<PluginInspectReport, "plugin" | "shape" | "usesLegacyBeforeAgentStart"> & {
    diagnostics: readonly PluginDiagnostic[];
    hasRuntimeMemoryEmbeddingProviderRegistration: boolean;
  },
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
  const usesMemoryEmbeddingProviderApi =
    inspect.plugin.memoryEmbeddingProviderIds.length > 0 ||
    (inspect.plugin.contracts?.memoryEmbeddingProviders?.length ?? 0) > 0 ||
    inspect.hasRuntimeMemoryEmbeddingProviderRegistration;
  if (usesMemoryEmbeddingProviderApi && inspect.plugin.origin !== "bundled") {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "deprecated-memory-embedding-provider-api",
      compatCode: "deprecated-memory-embedding-provider-api",
      severity: "warn",
      message:
        "uses deprecated memory-specific embedding provider API; use api.registerEmbeddingProvider and contracts.embeddingProviders for new embedding providers.",
    });
  }
  if (usesRemovedSessionTranscriptFileApi(inspect)) {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "removed-session-transcript-file-api",
      compatCode: "removed-session-transcript-file-api",
      severity: "warn",
      message:
        "references removed session/transcript file APIs; migrate to session identity, SessionTranscriptUpdate.target, and Gateway/runtime session helpers.",
    });
  }
  return warnings;
}

const removedSessionTranscriptFileApiMarkers = [
  "saveSessionStore",
  "resolveSessionTranscriptPathInDir",
  "resolveAndPersistSessionFile",
  "readLatestAssistantTextFromSessionTranscript",
  "SessionTranscriptUpdate.sessionFile",
  "sessionFiles",
  "transcriptPath",
  "sessionFile",
] as const;

function usesRemovedSessionTranscriptFileApi(
  inspect: Pick<PluginInspectReport, "plugin"> & { diagnostics: readonly PluginDiagnostic[] },
): boolean {
  if (inspect.plugin.origin === "bundled") {
    return false;
  }
  const messages = [
    inspect.plugin.error,
    ...inspect.diagnostics.map((diagnostic) => diagnostic.message),
  ].filter((message): message is string => typeof message === "string" && message.length > 0);
  return messages.some((message) =>
    removedSessionTranscriptFileApiMarkers.some((marker) => message.includes(marker)),
  );
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
  resolvedConfig?: OpenClawConfig;
};

function buildPluginReport(
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const rawConfig = params?.config ?? getRuntimeConfig();
  const initialWorkspaceDir =
    params?.workspaceDir ??
    resolveAgentWorkspaceDir(rawConfig, resolveDefaultAgentId(rawConfig), params?.env);
  const metadataSnapshot = !loadModules
    ? loadPluginMetadataSnapshot({
        config: rawConfig,
        env: params?.env ?? process.env,
        workspaceDir: initialWorkspaceDir,
      })
    : undefined;
  const baseContext = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params?.env,
    logger: params?.logger,
    workspaceDir: initialWorkspaceDir,
    manifestRegistry: metadataSnapshot?.manifestRegistry,
  });
  const workspaceDir =
    baseContext.workspaceDir ?? initialWorkspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const context =
    workspaceDir === baseContext.workspaceDir
      ? baseContext
      : {
          ...baseContext,
          workspaceDir,
        };
  const config = context.config;

  // Apply bundled-provider allowlist compat so that `plugins list` and `doctor`
  // report the same loaded/disabled status the gateway uses at runtime.  Without
  const bundledProviderIds = resolveBundledProviderCompatPluginIds({
    config,
    workspaceDir,
    env: params?.env,
    manifestRegistry: metadataSnapshot?.manifestRegistry,
  });
  const runtimeCompatConfig = withBundledPluginEnablementCompat({
    config,
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
            manifestRegistry: metadataSnapshot?.manifestRegistry,
            runtimeContext: context,
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
        dependencyStatus:
          plugin.dependencyStatus ??
          buildPluginDependencyStatus({
            rootDir: plugin.rootDir,
            dependencies: metadataSnapshot?.byPluginId.get(plugin.id)?.packageDependencies,
            optionalDependencies: metadataSnapshot?.byPluginId.get(plugin.id)
              ?.packageOptionalDependencies,
          }),
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
  resolvedConfig?: OpenClawConfig;
}): PluginInspectReport | null {
  const rawConfig = params.config ?? getRuntimeConfig();
  const config =
    params.resolvedConfig ??
    resolvePluginRuntimeLoadContext({
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
  const gatewayMethods = (report.gatewayMethodDescriptors ?? [])
    .filter(
      (descriptor) => descriptor.owner.kind === "plugin" && descriptor.owner.pluginId === plugin.id,
    )
    .map((descriptor) => descriptor.name);

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
  const hasRuntimeMemoryEmbeddingProviderRegistration = report.memoryEmbeddingProviders.some(
    (entry) => entry.pluginId === plugin.id,
  );
  const compatibility = buildCompatibilityNoticesForInspect({
    plugin,
    shape,
    usesLegacyBeforeAgentStart,
    diagnostics,
    hasRuntimeMemoryEmbeddingProviderRegistration,
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
    gatewayMethods,
    mcpServers,
    lspServers,
    httpRouteCount: plugin.httpRoutes,
    bundleCapabilities: plugin.bundleCapabilities ?? [],
    diagnostics,
    policy: {
      allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
      allowConversationAccess: policyEntry?.hooks?.allowConversationAccess,
      hookTimeoutMs: policyEntry?.hooks?.timeoutMs,
      hookTimeouts: policyEntry?.hooks?.timeouts ? { ...policyEntry.hooks.timeouts } : undefined,
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
  const config = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params?.env,
    logger: params?.logger,
    workspaceDir: params?.workspaceDir,
  }).config;
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
        workspaceDir: params?.workspaceDir,
        env: params?.env,
        resolvedConfig: config,
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
