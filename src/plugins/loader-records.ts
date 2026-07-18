/** Converts loaded plugin registries into stable plugin records for status and diagnostics. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PluginCompatCode } from "./compat/registry.js";
import type { PluginActivationState } from "./config-state.js";
import type { PluginBundleFormat, PluginDiagnosticCode, PluginFormat } from "./manifest-types.js";
import type { PluginManifestContracts } from "./manifest.js";
import { isPluginLifecycleTraceEnabled } from "./plugin-lifecycle-trace.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import {
  formatPluginVerificationDiagnostic,
  type DegradedPlugin,
} from "./runtime-degraded-state.js";
import type { PluginLogger } from "./types.js";

/** Builds the registry record shape shared by plugin loading, status, and diagnostics. */
export function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  packageName?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  source: string;
  rootDir?: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  trustedOfficialInstall?: boolean;
  enabled: boolean;
  compat?: readonly PluginCompatCode[];
  activationState?: PluginActivationState;
  syntheticAuthRefs?: string[];
  channelIds?: readonly string[];
  providerIds?: readonly string[];
  configSchema: boolean;
  contracts?: PluginManifestContracts;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    packageName: params.packageName,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    bundleCapabilities: params.bundleCapabilities,
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    trustedOfficialInstall: params.trustedOfficialInstall,
    enabled: params.enabled,
    compat: params.compat,
    explicitlyEnabled: params.activationState?.explicitlyEnabled,
    activated: params.activationState?.activated,
    activationSource: params.activationState?.source,
    activationReason: params.activationState?.reason,
    syntheticAuthRefs: params.syntheticAuthRefs ?? [],
    // Disabled records still enter the registry so status/doctor can explain why they are inactive.
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [...(params.channelIds ?? [])],
    cliBackendIds: [],
    providerIds: [...(params.providerIds ?? [])],
    embeddingProviderIds: [...(params.contracts?.embeddingProviders ?? [])],
    speechProviderIds: [...(params.contracts?.speechProviders ?? [])],
    realtimeTranscriptionProviderIds: [...(params.contracts?.realtimeTranscriptionProviders ?? [])],
    realtimeVoiceProviderIds: [...(params.contracts?.realtimeVoiceProviders ?? [])],
    mediaUnderstandingProviderIds: [...(params.contracts?.mediaUnderstandingProviders ?? [])],
    transcriptSourceProviderIds: [...(params.contracts?.transcriptSourceProviders ?? [])],
    imageGenerationProviderIds: [...(params.contracts?.imageGenerationProviders ?? [])],
    videoGenerationProviderIds: [...(params.contracts?.videoGenerationProviders ?? [])],
    musicGenerationProviderIds: [...(params.contracts?.musicGenerationProviders ?? [])],
    webFetchProviderIds: [...(params.contracts?.webFetchProviders ?? [])],
    webSearchProviderIds: [...(params.contracts?.webSearchProviders ?? [])],
    migrationProviderIds: [...(params.contracts?.migrationProviders ?? [])],
    contextEngineIds: [],
    memoryEmbeddingProviderIds: [...(params.contracts?.memoryEmbeddingProviders ?? [])],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
    contracts: params.contracts,
  };
}

/** Marks a discovered plugin inactive without discarding its metadata record. */
export function markPluginActivationDisabled(record: PluginRecord, reason?: string): void {
  record.activated = false;
  record.activationSource = "disabled";
  record.activationReason = reason;
}

/** Records a boot-time payload quarantine without importing or activating the plugin. */
export function recordPluginConfiguredUnavailable(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  origin: PluginRecord["origin"];
  degradedPlugin: DegradedPlugin;
}): void {
  const error = formatPluginVerificationDiagnostic(params.degradedPlugin.diagnostic);
  params.record.status = "error";
  params.record.error = error;
  params.record.failurePhase = "validation";
  params.record.activated = false;
  params.record.activationReason = `configured-unavailable: ${params.degradedPlugin.diagnostic.reason}`;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.record.id, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    code: "plugin-verification",
    message: error,
  });
}

/** Joins auto-enable reasons into the single registry field shown by status surfaces. */
export function formatAutoEnabledActivationReason(
  reasons: readonly string[] | undefined,
): string | undefined {
  if (!reasons || reasons.length === 0) {
    return undefined;
  }
  return reasons.join("; ");
}

/** Records a loader failure in the registry, diagnostics list, and operator log consistently. */
export function recordPluginError(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  phase: PluginRecord["failurePhase"];
  error: unknown;
  logPrefix: string;
  diagnosticMessagePrefix: string;
  diagnosticCode?: PluginDiagnosticCode;
}) {
  const errorText =
    isPluginLifecycleTraceEnabled() &&
    params.error instanceof Error &&
    typeof params.error.stack === "string"
      ? params.error.stack
      : String(params.error);
  const deprecatedApiHint =
    errorText.includes("api.registerHttpHandler") && errorText.includes("is not a function")
      ? "deprecated api.registerHttpHandler(...) was removed; use api.registerHttpRoute(...) for plugin-owned routes or registerPluginHttpRoute(...) for dynamic lifecycle routes"
      : null;
  // Rewrite the common removed-API failure into an actionable migration hint while preserving detail.
  const displayError = deprecatedApiHint ? `${deprecatedApiHint} (${errorText})` : errorText;
  params.logger.error(`${params.logPrefix}${displayError}`);
  params.record.status = "error";
  params.record.error = displayError;
  params.record.failedAt = new Date();
  params.record.failurePhase = params.phase;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `${params.diagnosticMessagePrefix}${displayError}`,
    ...(params.diagnosticCode ? { code: params.diagnosticCode } : {}),
  });
}

/** Groups failed plugin ids by loader phase for compact startup summaries. */
export function formatPluginFailureSummary(failedPlugins: PluginRecord[]): string {
  const grouped = new Map<NonNullable<PluginRecord["failurePhase"]>, string[]>();
  for (const plugin of failedPlugins) {
    const phase = plugin.failurePhase ?? "load";
    const ids = grouped.get(phase);
    if (ids) {
      ids.push(plugin.id);
      continue;
    }
    grouped.set(phase, [plugin.id]);
  }
  return [...grouped.entries()].map(([phase, ids]) => `${phase}: ${ids.join(", ")}`).join("; ");
}

function isPluginLoadDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(env.OPENCLAW_PLUGIN_LOAD_DEBUG);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function describePluginModuleExportShape(
  value: unknown,
  label = "export",
  seen: Set<unknown> = new Set(),
): string[] {
  if (value === null) {
    return [`${label}:null`];
  }
  if (typeof value !== "object") {
    return [`${label}:${typeof value}`];
  }
  if (seen.has(value)) {
    return [`${label}:circular`];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  const visibleKeys = keys.slice(0, 8);
  const extraCount = keys.length - visibleKeys.length;
  const keySummary =
    visibleKeys.length > 0
      ? `${visibleKeys.join(",")}${extraCount > 0 ? `,+${extraCount}` : ""}`
      : "none";
  const details = [`${label}:object keys=${keySummary}`];

  for (const key of ["default", "module", "register", "activate"]) {
    if (Object.hasOwn(record, key)) {
      details.push(...describePluginModuleExportShape(record[key], `${label}.${key}`, seen));
    }
  }
  return details;
}

export function formatMissingPluginRegisterError(
  moduleExport: unknown,
  env: NodeJS.ProcessEnv,
): string {
  const message = "plugin export missing register/activate";
  if (!isPluginLoadDebugEnabled(env)) {
    return message;
  }
  return `${message} (module shape: ${describePluginModuleExportShape(moduleExport).join("; ")})`;
}
