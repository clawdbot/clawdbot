// Builds plugin status snapshots for CLI and diagnostics.
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import {
  inspectBundleMcpRuntimeSupport,
  inspectNativePluginMcpRuntimeSupport,
} from "./bundle-mcp.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  appendPluginControlPlaneWorkspaceDiagnostic,
  resolvePluginControlPlaneWorkspace,
} from "./control-plane-workspace.js";
import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import {
  buildPluginShapeSummary,
  type PluginCapabilityEntry,
  type PluginInspectShape,
} from "./inspect-shape.js";
import {
  acquirePluginRegistryForInspection,
  loadPluginRegistryHandle,
  resolveCompatibleRuntimePluginRegistry,
} from "./loader.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { tracksPluginDependencyStatus } from "./official-external-plugin-repair-hints.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "./plugin-lifecycle-trace.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import type { PluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import { buildPluginRuntimeLoadOptions } from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
import { loadPluginMetadataRegistrySnapshot } from "./runtime/metadata-registry-loader.js";
import {
  formatPluginCompatibilityNotice,
  type PluginCompatibilityNotice,
} from "./status-compatibility.js";
import {
  buildPluginDependencyStatus,
  projectPluginDependencyHealth,
} from "./status-dependencies-core.js";
import { collectPluginCapabilityConsentDiagnostics } from "./status-snapshot.js";
import type { PluginHookName, PluginLogger } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
  workspaceScope: "selected" | "omitted";
};

type PluginStatusReportLike = PluginRegistry & { workspaceDir?: string };

export {
  buildPluginRegistrySnapshotReport,
  type PluginRegistryStatusReport,
} from "./status-snapshot.js";
export type { PluginCapabilityKind, PluginInspectShape } from "./inspect-shape.js";

export {
  formatPluginCompatibilityNotice,
  summarizePluginCompatibility,
} from "./status-compatibility.js";
export type {
  PluginCompatibilityNotice,
  PluginCompatibilitySummary,
} from "./status-compatibility.js";

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
    unsupported?: boolean;
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
  compatibility: PluginCompatibilityNotice[];
};

function buildCompatibilityNoticesForInspect(
  inspect: Pick<PluginInspectReport, "plugin" | "shape"> & {
    diagnostics: readonly PluginDiagnostic[];
  },
): PluginCompatibilityNotice[] {
  const warnings: PluginCompatibilityNotice[] = [];
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
  /** Capture full registrations without starting channel runtime sidecars. */
  runtimeInspection?: boolean;
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  metadataSnapshot?: PluginMetadataSnapshot;
};

function preparePluginReport(params: PluginReportParams | undefined) {
  const rawConfig = params?.config ?? getRuntimeConfig();
  const workspace = resolvePluginControlPlaneWorkspace({
    config: rawConfig,
    env: params?.env,
    workspaceDir: params?.workspaceDir,
  });
  const initialWorkspaceDir = workspace.workspaceDir;
  const metadataSnapshot =
    params?.metadataSnapshot ??
    loadPluginMetadataSnapshot({
      config: rawConfig,
      env: params?.env ?? process.env,
      workspaceDir: initialWorkspaceDir,
      ...(params?.onlyPluginIds !== undefined ? { pluginIds: params.onlyPluginIds } : {}),
    });
  const baseContext = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params?.env,
    logger: params?.logger,
    workspaceDir: initialWorkspaceDir,
    onlyPluginIds: params?.onlyPluginIds,
    metadataSnapshot,
  });
  const workspaceDir = baseContext.workspaceDir ?? initialWorkspaceDir;
  const context =
    workspaceDir === baseContext.workspaceDir
      ? baseContext
      : {
          ...baseContext,
          workspaceDir,
        };
  const manifestByPluginId = metadataSnapshot.byPluginId;
  // Runtime records drop package build metadata; the installed index still owns it.
  const packageBuildByPluginId = new Map(
    metadataSnapshot.index.plugins.map((plugin) => [plugin.pluginId, plugin.packageBuild]),
  );
  const config = context.config;

  // Apply bundled-provider allowlist compat so that `plugins list` and `doctor`
  // report the same loaded/disabled status the gateway uses at runtime.
  const bundledProviderIds = resolveBundledProviderCompatPluginIds({
    config,
    workspaceDir,
    env: params?.env,
    manifestRegistry: metadataSnapshot.manifestRegistry,
  });
  const runtimeCompatConfig = withBundledPluginEnablementCompat({
    config,
    pluginIds: bundledProviderIds,
    ...(params?.env ? { env: params.env } : {}),
    activation: "defaults",
  });
  const onlyPluginIds =
    params?.effectiveOnly === true
      ? resolveEffectivePluginIds({
          config: rawConfig,
          workspaceDir,
          env: params?.env ?? process.env,
          metadataSnapshot,
        })
      : params?.onlyPluginIds === undefined
        ? undefined
        : [...params.onlyPluginIds];

  return {
    rawConfig,
    workspace,
    workspaceDir,
    metadataSnapshot,
    context,
    manifestByPluginId,
    packageBuildByPluginId,
    runtimeCompatConfig,
    onlyPluginIds,
    runtimeLoadOptions: buildPluginRuntimeLoadOptions(context, {
      config: runtimeCompatConfig,
      activationSourceConfig: rawConfig,
      workspaceDir,
      env: params?.env,
      loadModules: true,
      cache: false,
      onlyPluginIds,
      toolDiscovery: params?.runtimeInspection,
    }),
  };
}

function buildPluginReport(
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const prepared = preparePluginReport(params);
  const { rawConfig, workspaceDir, metadataSnapshot, context, runtimeCompatConfig, onlyPluginIds } =
    prepared;
  const registry = loadModules
    ? tracePluginLifecyclePhase(
        "runtime plugin registry load",
        () => loadPluginRegistryHandle(prepared.runtimeLoadOptions),
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
            manifestRegistry: metadataSnapshot.manifestRegistry,
            runtimeContext: context,
          }),
        { surface: "status", onlyPluginCount: onlyPluginIds?.length },
      );
  return projectPluginReport(registry, prepared, params, loadModules);
}

function projectPluginReport(
  registry: PluginRegistry,
  prepared: ReturnType<typeof preparePluginReport>,
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const { workspace, workspaceDir, metadataSnapshot, manifestByPluginId, packageBuildByPluginId } =
    prepared;
  const importedPluginIds = new Set([
    ...(loadModules
      ? registry.plugins
          .filter((plugin) => plugin.status === "loaded" && plugin.format !== "bundle")
          .map((plugin) => plugin.id)
      : []),
    ...listImportedRuntimePluginIds(),
    ...listImportedBundledPluginFacadeIds(),
  ]);

  return projectPluginDependencyHealth({
    workspaceDir,
    workspaceScope: workspace.workspaceScope,
    ...registry,
    diagnostics: appendPluginControlPlaneWorkspaceDiagnostic(
      [
        ...registry.diagnostics,
        ...collectPluginCapabilityConsentDiagnostics({
          index: metadataSnapshot.index,
          manifests: manifestByPluginId,
        }),
      ],
      workspace,
    ),
    plugins: registry.plugins.map((plugin) =>
      Object.assign({}, plugin, {
        imported: plugin.format !== `bundle` && importedPluginIds.has(plugin.id),
        version: resolveReportedPluginVersion(plugin, params?.env),
        dependencyStatus:
          plugin.dependencyStatus ??
          (tracksPluginDependencyStatus({
            origin: plugin.origin,
            pluginId: plugin.id,
            packageName: plugin.packageName ?? manifestByPluginId.get(plugin.id)?.packageName,
            packageBuild: packageBuildByPluginId.get(plugin.id),
          })
            ? buildPluginDependencyStatus({
                rootDir: plugin.rootDir,
                dependencies: manifestByPluginId.get(plugin.id)?.packageDependencies,
                optionalDependencies: manifestByPluginId.get(plugin.id)
                  ?.packageOptionalDependencies,
              })
            : undefined),
      }),
    ),
  });
}

export function buildPluginSnapshotReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, false);
}

export function buildPluginDiagnosticsReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, true);
}

/** Serializes an owned inspection before disposing its registration resources. */
export async function withPluginDiagnosticsReportForInspection<Result extends string | undefined>(
  params: PluginReportParams,
  formatReport: (report: PluginStatusReport) => Result,
): Promise<Result> {
  const prepared = preparePluginReport(params);
  const inspection = await tracePluginLifecyclePhaseAsync(
    "runtime plugin registry load",
    () => acquirePluginRegistryForInspection(prepared.runtimeLoadOptions),
    { surface: "status", onlyPluginCount: prepared.onlyPluginIds?.length },
  );
  let output: Result;
  try {
    output = formatReport(projectPluginReport(inspection.registry, prepared, params, true));
  } catch (error) {
    try {
      await inspection.release();
    } catch (disposalError) {
      throw new AggregateError(
        [error, disposalError],
        "Plugin inspection report and disposal failed",
        { cause: disposalError },
      );
    }
    throw error;
  }
  await inspection.release();
  return output;
}

type PluginInspectParams = Pick<
  PluginReportParams,
  "config" | "workspaceDir" | "env" | "logger"
> & {
  report?: PluginStatusReportLike;
};

function resolvePluginInspectContext({ report, ...params }: PluginInspectParams) {
  const { rawConfig, config } = resolvePluginRuntimeLoadContext(params);
  return {
    report: report ?? buildPluginDiagnosticsReport({ ...params, config: rawConfig }),
    entries: normalizePluginsConfig(config.plugins).entries,
  };
}

export function buildPluginInspectReport({
  id,
  ...params
}: PluginInspectParams & {
  id: string;
}): PluginInspectReport | null {
  const context = resolvePluginInspectContext(params);
  const plugin =
    context.report.plugins.find((entry) => entry.id === id) ??
    context.report.plugins.find((entry) => entry.name === id);
  return plugin ? buildPluginInspectRecord(plugin, context) : null;
}

function buildPluginInspectRecord(
  plugin: PluginRegistry["plugins"][number],
  { report, entries }: ReturnType<typeof resolvePluginInspectContext>,
): PluginInspectReport {
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
  const policyEntry = entries[normalizePluginPolicyId(plugin.id)];
  const shapeSummary = buildPluginShapeSummary({ plugin, report });
  const shape = shapeSummary.shape;
  const gatewayMethods = (report.gatewayMethodDescriptors ?? [])
    .filter(
      (descriptor) => descriptor.owner.kind === "plugin" && descriptor.owner.pluginId === plugin.id,
    )
    .map((descriptor) => descriptor.name);

  // MCP metadata is process-stable and comes from the discovered plugin manifest.
  let mcpServers: PluginInspectReport["mcpServers"] = [];
  if (plugin.rootDir) {
    const mcpSupport =
      plugin.format === "bundle" && plugin.bundleFormat
        ? inspectBundleMcpRuntimeSupport({
            pluginId: plugin.id,
            rootDir: plugin.rootDir,
            bundleFormat: plugin.bundleFormat,
          })
        : plugin.mcpServers
          ? inspectNativePluginMcpRuntimeSupport({
              rootDir: plugin.rootDir,
              mcpServers: plugin.mcpServers,
            })
          : undefined;
    if (mcpSupport) {
      const stdioServerNames = new Set(mcpSupport.stdioServerNames);
      mcpServers = [
        ...mcpSupport.supportedServerNames.map((name) => ({
          name,
          hasStdioTransport: stdioServerNames.has(name),
        })),
        ...mcpSupport.unsupportedServerNames.map((name) => ({
          name,
          hasStdioTransport: false,
          unsupported: true,
        })),
      ];
    }
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

  const compatibility = buildCompatibilityNoticesForInspect({
    plugin,
    shape,
    diagnostics,
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
    compatibility,
  };
}

export function buildAllPluginInspectReports(
  params: PluginInspectParams = {},
): PluginInspectReport[] {
  const context = resolvePluginInspectContext(params);
  return context.report.plugins.map((plugin) => buildPluginInspectRecord(plugin, context));
}

export function buildPluginCompatibilityWarnings(params?: PluginInspectParams): string[] {
  return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}

export function buildPluginCompatibilityNotices(
  params?: PluginInspectParams,
): PluginCompatibilityNotice[] {
  const registry = params?.report ?? buildPluginDiagnosticsReport(params);
  return registry.plugins.flatMap((plugin) =>
    buildCompatibilityNoticesForInspect({
      plugin,
      shape: buildPluginShapeSummary({ plugin, report: registry }).shape,
      diagnostics: registry.diagnostics.filter((entry) => entry.pluginId === plugin.id),
    }),
  );
}

export function buildPluginCompatibilitySnapshotNotices(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginCompatibilityNotice[] {
  const report = buildPluginSnapshotReport(params);
  const context = resolvePluginRuntimeLoadContext(params);
  const runtimeRegistry = resolveCompatibleRuntimePluginRegistry(
    buildPluginRuntimeLoadOptions(context),
  );
  const registeredPlugins = new Map(runtimeRegistry?.plugins.map((plugin) => [plugin.id, plugin]));
  // Hook shape is a runtime registration fact. Reuse compatible live registrations without
  // importing cold plugins or guessing their capabilities from a manifest-only snapshot.
  const registrationReport = runtimeRegistry
    ? {
        ...report,
        ...runtimeRegistry,
        workspaceDir: report.workspaceDir,
        plugins: report.plugins.map((plugin) => ({
          ...plugin,
          ...registeredPlugins.get(plugin.id),
          imported: plugin.imported,
        })),
      }
    : report;
  return buildPluginCompatibilityNotices({
    ...params,
    report: registrationReport,
  });
}
