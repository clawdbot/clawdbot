import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { PluginCompatCode } from "./compat/registry.js";
import type { PluginActivationState } from "./config-state.js";
import type { PluginBundleFormat, PluginFormat } from "./manifest-types.js";
import type { PluginManifestContracts } from "./manifest.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import type { PluginLogger } from "./types.js";

export function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  source: string;
  rootDir?: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  compat?: readonly PluginCompatCode[];
  activationState?: PluginActivationState;
  syntheticAuthRefs?: string[];
  configSchema: boolean;
  contracts?: PluginManifestContracts;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    bundleCapabilities: params.bundleCapabilities,
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    compat: params.compat,
    explicitlyEnabled: params.activationState?.explicitlyEnabled,
    activated: params.activationState?.activated,
    activationSource: params.activationState?.source,
    activationReason: params.activationState?.reason,
    syntheticAuthRefs: params.syntheticAuthRefs ?? [],
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
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
    contextEngineIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
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

export function markPluginActivationDisabled(record: PluginRecord, reason?: string): void {
  record.activated = false;
  record.activationSource = "disabled";
  record.activationReason = reason;
}

export function formatAutoEnabledActivationReason(
  reasons: readonly string[] | undefined,
): string | undefined {
  if (!reasons || reasons.length === 0) {
    return undefined;
  }
  return reasons.join("; ");
}

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
}) {
  const errorText =
    process.env.OPENCLAW_PLUGIN_LOADER_DEBUG_STACKS === "1" &&
    params.error instanceof Error &&
    typeof params.error.stack === "string"
      ? params.error.stack
      : String(params.error);
  const deprecatedApiHint =
    errorText.includes("api.registerHttpHandler") && errorText.includes("is not a function")
      ? "deprecated api.registerHttpHandler(...) was removed; use api.registerHttpRoute(...) for plugin-owned routes or registerPluginHttpRoute(...) for dynamic lifecycle routes"
      : null;
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
  });
}

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
    if (Object.prototype.hasOwnProperty.call(record, key)) {
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
