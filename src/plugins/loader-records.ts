/** Converts loaded plugin registries into stable plugin records for status and diagnostics. */
import { collectErrorGraphCandidates, extractErrorCode, readErrorCause } from "../infra/errors.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { VERSION } from "../version.js";
import type { PluginCompatCode } from "./compat/registry.js";
import type { PluginActivationState } from "./config-state.js";
import type {
  PluginBundleFormat,
  PluginDiagnostic,
  PluginDiagnosticCode,
  PluginFormat,
} from "./manifest-types.js";
import type {
  PluginManifestContracts,
  PluginManifestControlUi,
  PluginManifestDashboard,
  PluginManifestMcpServer,
} from "./manifest.js";
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
  packageVersion?: string;
  version?: string;
  builtWithOpenClawVersion?: string;
  packageName?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  source: string;
  rootDir?: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  trustedOfficialInstall?: boolean;
  trust?: PluginRecord["trust"];
  enabled: boolean;
  compat?: readonly PluginCompatCode[];
  activationState?: PluginActivationState;
  syntheticAuthRefs?: string[];
  channelIds?: readonly string[];
  providerIds?: readonly string[];
  configSchema: boolean;
  contracts?: PluginManifestContracts;
  dashboard?: PluginManifestDashboard;
  controlUi?: PluginManifestControlUi;
  mcpServers?: Record<string, PluginManifestMcpServer>;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    packageVersion: params.packageVersion,
    version: params.version,
    builtWithOpenClawVersion: params.builtWithOpenClawVersion,
    packageName: params.packageName,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    bundleCapabilities: params.bundleCapabilities,
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    trustedOfficialInstall: params.trustedOfficialInstall,
    trust: params.trust,
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
    dashboard: params.dashboard,
    controlUi: params.controlUi,
    mcpServers: params.mcpServers,
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
  degradedPlugin: DegradedPlugin;
}): void {
  const error = formatPluginVerificationDiagnostic(params.degradedPlugin.diagnostic);
  params.record.status = "error";
  params.record.error = error;
  params.record.failurePhase = "validation";
  params.record.activated = false;
  params.record.activationReason = `configured-unavailable: ${params.degradedPlugin.diagnostic.reason}`;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.record.id, params.record.origin);
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
  return reasons?.length ? reasons.join("; ") : undefined;
}

// A plugin-thrown error may expose throwing `cause`/`code` accessors; diagnostics inside the
// loader's catch handler must classify without rethrowing.
function readCauseOrNothing(node: unknown): unknown[] {
  try {
    return [readErrorCause(node)];
  } catch {
    return [];
  }
}

function resolvePluginImportHint(
  node: unknown,
  record: PluginRecord,
  missingDependencyHint?: string,
): { hint: string; sdkCompatibility?: PluginDiagnostic["sdkCompatibility"] } | undefined {
  try {
    const text = String(node).replaceAll("\\", "/");
    const seam =
      /(?:The requested module ['"]openclaw\/|Package subpath ['"]\.\/)(plugin-sdk\/[\w./-]{1,160})['"] (?:does not provide an export named|is not defined by ["']exports["'] in .*\/openclaw\/package\.json)/.exec(
        text,
      )?.[1];
    if (seam) {
      const sdkCompatibility = {
        seam: `openclaw/${seam}`,
        coreVersion: VERSION,
        builtWithOpenClawVersion: record.builtWithOpenClawVersion,
        nestedSdk: Boolean(
          record.rootDir &&
          text.includes(
            `${record.rootDir.replaceAll("\\", "/")}/node_modules/openclaw/package.json`,
          ),
        ),
      };
      // Plugin ids need not be shell-safe; keep unsafe ids out of copy-paste commands.
      const repair = sdkCompatibility.nestedSdk
        ? "this plugin bundles an incompatible OpenClaw SDK; update it or contact its author"
        : /^[a-z0-9_][a-z0-9_.-]*$/i.test(record.id)
          ? `run \`openclaw plugins update ${record.id}\``
          : "update this plugin or contact its author";
      return {
        hint: `Plugin ${record.id} cannot import ${sdkCompatibility.seam} (built with OpenClaw ${record.builtWithOpenClawVersion ?? "unknown"}; running core ${VERSION}); ${repair}`,
        sdkCompatibility,
      };
    }
    const code = extractErrorCode(node);
    return missingDependencyHint && (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND")
      ? { hint: missingDependencyHint }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Records a loader failure in the registry, diagnostics list, and operator log consistently. */
export function recordPluginError(params: {
  logger?: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  phase: PluginRecord["failurePhase"];
  error: unknown;
  logPrefix?: string;
  diagnosticMessagePrefix?: string;
  diagnosticCode?: PluginDiagnosticCode;
  /** Shown when the failure is a missing module so operators learn the install path. */
  missingDependencyHint?: string;
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
  // Native-require failures rewrap the Node error, so the missing-module code can sit on a cause.
  const importHint =
    params.phase === "validation"
      ? undefined
      : collectErrorGraphCandidates(params.error, readCauseOrNothing)
          .map((node) => resolvePluginImportHint(node, params.record, params.missingDependencyHint))
          .find((hint) => hint !== undefined);
  // Rewrite the common removed-API failure into an actionable migration hint while preserving detail.
  const hint = params.phase === "validation" ? undefined : (deprecatedApiHint ?? importHint?.hint);
  const displayError = hint ? `${hint} (${errorText})` : errorText;
  params.logger?.error(`${params.logPrefix ?? ""}${displayError}`);
  params.record.status = "error";
  params.record.error = displayError;
  params.record.failedAt = new Date();
  params.record.failurePhase = params.phase;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.record.id, params.record.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `${params.diagnosticMessagePrefix ?? ""}${displayError}`,
    ...(importHint?.sdkCompatibility
      ? {
          code: params.diagnosticCode ?? "sdk-incompatible",
          sdkCompatibility: importHint.sdkCompatibility,
        }
      : params.diagnosticCode
        ? { code: params.diagnosticCode }
        : {}),
  });
}

/** Groups failed plugin ids by loader phase for compact startup summaries. */
export function formatPluginFailureSummary(failedPlugins: PluginRecord[]): string {
  const grouped = new Map<NonNullable<PluginRecord["failurePhase"]>, string[]>();
  for (const plugin of failedPlugins) {
    const phase = plugin.failurePhase ?? "load";
    const ids = grouped.get(phase) ?? [];
    ids.push(plugin.id);
    grouped.set(phase, ids);
  }
  return [...grouped.entries()].map(([phase, ids]) => `${phase}: ${ids.join(", ")}`).join("; ");
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
  if (parseBooleanValue(env.OPENCLAW_PLUGIN_LOAD_DEBUG) !== true) {
    return message;
  }
  return `${message} (module shape: ${describePluginModuleExportShape(moduleExport).join("; ")})`;
}
