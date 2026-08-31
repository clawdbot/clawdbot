// Runtime implementations for `openclaw plugins` subcommands. Heavy plugin modules stay
// lazy-loaded so the base CLI can start without activating the plugin registry.
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  collectConfiguredRuntimePluginIds,
  resolveConfiguredRuntimePluginInstallCandidate,
} from "../commands/doctor/shared/configured-runtime-plugin-installs.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  getRuntimeConfig,
  readConfigFileSnapshot,
  replaceConfigFile,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitDiagnosticsTimelineEvent } from "../infra/diagnostics-timeline.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomeInString } from "../utils.js";
import { formatMissingPluginMessage } from "./error-format.js";
import { ExpectedCliError } from "./failure-output.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import type {
  PluginDoctorOptions,
  PluginMarketplaceEntriesOptions,
  PluginMarketplaceListOptions,
  PluginMarketplaceRefreshOptions,
  PluginRegistryOptions,
} from "./plugins-cli.js";

type PluginInstallActionOptions = {
  acceptCapabilities?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  force?: boolean;
  link?: boolean;
  pin?: boolean;
  marketplace?: string;
};

function createModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

const loadPluginsConfigState = createModuleLoader(() => import("../plugins/config-state.js"));
const loadPluginsStatus = createModuleLoader(() => import("../plugins/status.js"));
const loadPluginSlotSelection = createModuleLoader(() => import("../plugins/slot-selection.js"));
const loadPluginsCommandHelpers = createModuleLoader(() => import("./plugins-command-helpers.js"));
const loadPluginsRegistryRefresh = createModuleLoader(
  () => import("../plugins/registry-refresh.js"),
);

function countEnabledPlugins(plugins: readonly { enabled: boolean }[]): number {
  return plugins.filter((plugin) => plugin.enabled).length;
}

function formatRegistryState(state: "missing" | "fresh" | "stale"): string {
  return state === "fresh" ? theme.success(state) : theme.warn(state);
}

function reportMissingPlugin(id: string) {
  defaultRuntime.error(formatMissingPluginMessage({ id, includeSearch: true }));
  return defaultRuntime.exit(1);
}

function isConfigSelectedShadowDiagnostic(entry: { level?: string; message?: string }): boolean {
  return (
    entry.level === "warn" &&
    typeof entry.message === "string" &&
    entry.message.includes("duplicate plugin id resolved by explicit config-selected plugin")
  );
}

function isErroredConfigSelectedShadowDiagnostic(params: {
  entry: { level?: string; message?: string; pluginId?: string };
  plugins: readonly { id: string; origin: string; status: string }[];
}): boolean {
  if (!params.entry.pluginId || !isConfigSelectedShadowDiagnostic(params.entry)) {
    return false;
  }
  return params.plugins.some(
    (plugin) =>
      plugin.id === params.entry.pluginId &&
      plugin.origin === "config" &&
      plugin.status === "error",
  );
}

function formatConfiguredRuntimePluginInstallSpec(params: {
  clawhubSpec?: string;
  defaultChoice?: string;
  npmSpec?: string;
  pluginId: string;
}): string {
  const clawhubSpec = params.clawhubSpec?.trim();
  const npmSpec = params.npmSpec?.trim();
  if (clawhubSpec && params.defaultChoice !== "npm") {
    return clawhubSpec;
  }
  return npmSpec ?? clawhubSpec ?? params.pluginId;
}

function pluginIdListIncludes(list: readonly string[] | undefined, pluginId: string): boolean {
  return Array.isArray(list) && list.some((entry) => entry.trim() === pluginId);
}

function formatBlockedRuntimePluginGuidance(params: {
  cfg: OpenClawConfig;
  pluginId: string;
}): string | undefined {
  const pluginId = params.pluginId;
  const alternative =
    pluginId === "acpx"
      ? "disable ACP/acpx in acp config"
      : 'change the runtime policy to "openclaw"';
  if (params.cfg.plugins?.enabled === false) {
    return `Enable plugin loading and the "${pluginId}" plugin, or ${alternative}.`;
  }
  if (pluginIdListIncludes(params.cfg.plugins?.deny, pluginId)) {
    return `Remove "${pluginId}" from plugins.deny and enable the "${pluginId}" plugin, or ${alternative}.`;
  }
  if (params.cfg.plugins?.entries?.[pluginId]?.enabled === false) {
    return `Set plugins.entries.${pluginId}.enabled=true or remove that disabled entry, or ${alternative}.`;
  }
  return undefined;
}

function formatDisabledRuntimePluginGuidance(params: {
  cfg: OpenClawConfig;
  pluginId: string;
}): string {
  const allow = params.cfg.plugins?.allow;
  const alternative =
    params.pluginId === "acpx"
      ? "disable ACP/acpx in acp config"
      : 'change the runtime policy to "openclaw"';
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(params.pluginId)) {
    return `Add "${params.pluginId}" to plugins.allow and enable the plugin, or ${alternative}.`;
  }
  return `Enable the "${params.pluginId}" plugin, or ${alternative}.`;
}

function collectConfiguredRuntimePluginWarnings(params: {
  cfg: OpenClawConfig;
  plugins: readonly { enabled?: boolean; id: string; status?: string }[];
}): string[] {
  const enabledPluginIds = new Set(
    params.plugins
      .filter((plugin) => plugin.enabled !== false && plugin.status !== "disabled")
      .map((plugin) => plugin.id),
  );
  return collectConfiguredRuntimePluginIds(params.cfg, {
    includeImplicitRuntimePreferences: false,
  }).flatMap((runtimeId) => {
    const candidate = resolveConfiguredRuntimePluginInstallCandidate(runtimeId);
    if (!candidate || enabledPluginIds.has(runtimeId)) {
      return [];
    }
    const disabledPluginRecord = params.plugins.find((plugin) => plugin.id === runtimeId);
    const blockedGuidance = formatBlockedRuntimePluginGuidance({
      cfg: params.cfg,
      pluginId: runtimeId,
    });
    if (blockedGuidance) {
      return [
        `- Configured runtime "${runtimeId}" requires the ${candidate.label} plugin, but "${runtimeId}" is blocked by plugin configuration. ${blockedGuidance}`,
      ];
    }
    if (disabledPluginRecord) {
      return [
        `- Configured runtime "${runtimeId}" requires the ${candidate.label} plugin, but "${runtimeId}" is disabled. ${formatDisabledRuntimePluginGuidance({ cfg: params.cfg, pluginId: runtimeId })}`,
      ];
    }
    const installSpec = formatConfiguredRuntimePluginInstallSpec(candidate);
    return [
      `- Configured runtime "${runtimeId}" requires the ${candidate.label} plugin, but no enabled "${runtimeId}" plugin was found. Run "openclaw doctor --fix" to install ${installSpec}, or install it manually with "openclaw plugins install ${installSpec}".`,
    ];
  });
}

/** Enable a plugin in config and refresh the registry snapshot for the changed policy. */
export async function runPluginsEnableCommand(
  idInput: string,
  opts: { acceptCapabilities?: boolean } = {},
): Promise<void> {
  assertConfigWriteAllowedInCurrentMode();
  return await withPluginLifecycleLease(
    {},
    async () => await runPluginsEnableCommandUnlocked(idInput, opts),
  );
}

async function runPluginsEnableCommandUnlocked(
  idInput: string,
  opts: { acceptCapabilities?: boolean },
): Promise<void> {
  let id = idInput;
  assertConfigWriteAllowedInCurrentMode();

  const { enableExplicitlySelectedPluginInConfig } = await import("../plugins/enable.js");
  const { normalizePluginId } = await loadPluginsConfigState();
  const { buildPluginRegistrySnapshotReport } = await loadPluginsStatus();
  const snapshot = await readConfigFileSnapshot();
  const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const report = buildPluginRegistrySnapshotReport({ config: cfg });
  id = normalizePluginId(id);
  const plugin = report.plugins.find((entry) => entry.id === id);
  if (!plugin) {
    return reportMissingPlugin(id);
  }
  const enableResult = enableExplicitlySelectedPluginInConfig(cfg, id, {
    updateChannelConfig: false,
  });
  // A blocked request must not displace the active slot or rewrite persisted state.
  if (!enableResult.enabled) {
    defaultRuntime.error(
      `Plugin "${id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`,
    );
    return defaultRuntime.exit(1);
  }
  if (!plugin.enabled || opts.acceptCapabilities) {
    const { resolvePluginCapabilityConsent } = await import("../plugins/capability-consent.js");
    const { ManagedPluginLifecycleError } =
      await import("../plugins/management-lifecycle-error.js");
    const consent = resolvePluginCapabilityConsentCliOptions({
      acceptCapabilities: opts.acceptCapabilities,
      action: "enable",
    });
    try {
      await resolvePluginCapabilityConsent({
        config: cfg,
        pluginId: id,
        ...consent,
      });
    } catch (error) {
      if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
        throw error;
      }
      defaultRuntime.error(error.message);
      return defaultRuntime.exit(1);
    }
  }

  const { applySlotSelectionForPlugin } = await loadPluginSlotSelection();
  const { logSlotWarnings } = await loadPluginsCommandHelpers();
  const { refreshPluginRegistryAfterConfigMutation } = await loadPluginsRegistryRefresh();
  let next: OpenClawConfig = enableResult.config;
  const slotResult = applySlotSelectionForPlugin(next, id);
  next = slotResult.config;
  await replaceConfigFile({
    nextConfig: next,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    // Source/runtime projection must retain the explicitly merged canonical
    // entry; otherwise compatibility-only nested settings are silently lost.
    writeOptions: {
      explicitSetPaths: [["plugins", "entries", enableResult.pluginId]],
    },
  });
  await refreshPluginRegistryAfterConfigMutation({
    config: next,
    reason: "policy-changed",
    invalidateRuntimeCache: false,
    policyPluginIds: [enableResult.pluginId],
    logger: {
      warn: (message) => defaultRuntime.log(theme.warn(message)),
    },
  });
  logSlotWarnings(slotResult.warnings);
  defaultRuntime.log(`Enabled plugin "${id}". Restart the gateway to apply.`);
}

/** Disable a plugin in config and refresh the registry snapshot for the changed policy. */
export async function runPluginsDisableCommand(idInput: string): Promise<void> {
  assertConfigWriteAllowedInCurrentMode();
  return await withPluginLifecycleLease(
    {},
    async () => await runPluginsDisableCommandUnlocked(idInput),
  );
}

async function runPluginsDisableCommandUnlocked(idInput: string): Promise<void> {
  let id = idInput;
  assertConfigWriteAllowedInCurrentMode();

  const { normalizePluginId } = await loadPluginsConfigState();
  const { buildPluginRegistrySnapshotReport } = await loadPluginsStatus();
  const { setPluginEnabledInConfig } = await import("./plugins-config.js");
  const { refreshPluginRegistryAfterConfigMutation } = await loadPluginsRegistryRefresh();
  const snapshot = await readConfigFileSnapshot();
  const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const report = buildPluginRegistrySnapshotReport({ config: cfg });
  id = normalizePluginId(id);
  if (!report.plugins.some((plugin) => plugin.id === id)) {
    return reportMissingPlugin(id);
  }
  const next = setPluginEnabledInConfig(cfg, id, false, {
    updateChannelConfig: false,
  });
  await replaceConfigFile({
    nextConfig: next,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    // `id` was normalized before discovery; persist that same canonical entry
    // so alias invocations cannot lose settings during source projection.
    writeOptions: {
      explicitSetPaths: [["plugins", "entries", id]],
    },
  });
  await refreshPluginRegistryAfterConfigMutation({
    config: next,
    reason: "policy-changed",
    invalidateRuntimeCache: false,
    policyPluginIds: [id],
    logger: {
      warn: (message) => defaultRuntime.log(theme.warn(message)),
    },
  });
  defaultRuntime.log(`Disabled plugin "${id}". Restart the gateway to apply.`);
}

export async function runPluginsInstallAction(
  raw: string,
  opts: PluginInstallActionOptions,
): Promise<void> {
  await tracePluginLifecyclePhaseAsync(
    "install command",
    async () => {
      const { runPluginInstallCommand } = await import("./plugins-install-command.js");
      await runPluginInstallCommand({
        raw,
        opts,
        allowInstallPolicyWarningPrompt: true,
        invalidateRuntimeCache: false,
      });
    },
    { command: "install" },
  );
}

/** Inspect or refresh the persisted plugin registry index. */
export async function runPluginsRegistryCommand(opts: PluginRegistryOptions): Promise<void> {
  const { inspectPluginRegistry } = await import("../plugins/plugin-registry.js");

  if (opts.refresh) {
    const { refreshPluginRegistry } = await import("../plugins/plugin-registry-refresh.js");
    return await withPluginLifecycleLease({}, async () => {
      const index = await refreshPluginRegistry({
        config: getRuntimeConfig(),
        reason: "manual",
      });
      if (opts.json) {
        defaultRuntime.writeJson({
          refreshed: true,
          registry: index,
        });
        return;
      }
      const total = index.plugins.length;
      const enabled = countEnabledPlugins(index.plugins);
      defaultRuntime.log(`Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`);
    });
  }

  const inspection = await inspectPluginRegistry({ config: getRuntimeConfig() });
  if (opts.json) {
    defaultRuntime.writeJson({
      state: inspection.state,
      refreshReasons: inspection.refreshReasons,
      persisted: inspection.persisted,
      current: inspection.current,
    });
    return;
  }

  const currentTotal = inspection.current.plugins.length;
  const currentEnabled = countEnabledPlugins(inspection.current.plugins);
  const persistedTotal = inspection.persisted?.plugins.length ?? 0;
  const persistedEnabled = inspection.persisted
    ? countEnabledPlugins(inspection.persisted.plugins)
    : 0;
  const lines = [
    `${theme.muted("State:")} ${formatRegistryState(inspection.state)}`,
    `${theme.muted("Current:")} ${currentEnabled}/${currentTotal} enabled plugins`,
    `${theme.muted("Persisted:")} ${persistedEnabled}/${persistedTotal} enabled plugins`,
  ];
  if (inspection.refreshReasons.length > 0) {
    lines.push(`${theme.muted("Refresh reasons:")} ${inspection.refreshReasons.join(", ")}`);
    lines.push(`${theme.muted("Repair:")} ${theme.command("openclaw plugins registry --refresh")}`);
  }
  defaultRuntime.log(lines.join("\n"));
}

/** Print plugin install-tree, compatibility, and plugin-owned config diagnostics. */
export async function runPluginsDoctorCommand(opts: PluginDoctorOptions = {}): Promise<void> {
  const {
    buildPluginCompatibilityNotices,
    buildPluginDiagnosticsReport,
    formatPluginCompatibilityNotice,
  } = await loadPluginsStatus();
  const {
    collectStalePluginConfigWarnings,
    isStalePluginAutoRepairBlocked,
    scanStalePluginConfig,
  } = await import("../commands/doctor/shared/stale-plugin-config.js");
  const cfg = getRuntimeConfig();
  const configSnapshot = await readConfigFileSnapshot().catch(() => null);
  const sourceCfg = configSnapshot?.sourceConfig ?? configSnapshot?.config ?? cfg;
  const report = buildPluginDiagnosticsReport({ config: cfg, effectiveOnly: true });
  const errors = report.plugins.filter((p) => p.status === "error");
  const diags = report.diagnostics.filter((entry) => !isConfigSelectedShadowDiagnostic(entry));
  const shadowed = report.diagnostics.filter((entry) =>
    isErroredConfigSelectedShadowDiagnostic({ entry, plugins: report.plugins }),
  );
  const compatibility = buildPluginCompatibilityNotices({ report });
  const pluginConfigWarnings = new Set([
    ...formatConfigIssueLines(
      (configSnapshot?.warnings ?? []).filter(
        ({ path }) => path === "plugins" || path.startsWith("plugins."),
      ),
    ),
    ...collectStalePluginConfigWarnings({
      hits: scanStalePluginConfig(sourceCfg, process.env),
      doctorFixCommand: "openclaw doctor --fix",
      autoRepairBlocked: isStalePluginAutoRepairBlocked(sourceCfg, process.env),
    }),
    ...collectConfiguredRuntimePluginWarnings({ cfg: sourceCfg, plugins: report.plugins }),
  ]);
  const hasInstallTreeIssues =
    [errors, diags, shadowed].some(({ length }) => length > 0) ||
    compatibility.some(({ severity }) => severity === "warn");
  const doctorOk = !hasInstallTreeIssues && pluginConfigWarnings.size === 0;
  process.exitCode = doctorOk ? 0 : 1;

  if (opts.json) {
    defaultRuntime.writeJson({
      ok: doctorOk,
      pluginErrors: errors.map((entry) => ({
        id: entry.id,
        ...(entry.failurePhase ? { failurePhase: entry.failurePhase } : {}),
        error: shortenHomeInString(entry.error ?? "failed to load"),
        source: shortenHomeInString(entry.source),
      })),
      diagnostics: diags.map((entry) => ({
        level: entry.level,
        ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
        message: shortenHomeInString(entry.message),
        ...(entry.source ? { source: shortenHomeInString(entry.source) } : {}),
      })),
      sourceShadowing: shadowed.map((entry) => {
        const active = report.plugins.find((plugin) => plugin.id === entry.pluginId);
        return {
          ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
          message: shortenHomeInString(entry.message),
          ...(active
            ? {
                active: {
                  source: shortenHomeInString(active.source),
                  origin: active.origin,
                  status: active.status,
                  ...(active.error ? { error: shortenHomeInString(active.error) } : {}),
                },
              }
            : {}),
          ...(entry.source ? { shadowedSource: shortenHomeInString(entry.source) } : {}),
          repair: [
            `openclaw plugins inspect ${entry.pluginId ?? "<plugin-id>"}`,
            "edit or remove the config-selected plugin source",
            "openclaw plugins registry --refresh",
            "openclaw gateway restart --force",
          ],
        };
      }),
      compatibility: compatibility.map((notice) => ({
        ...notice,
        message: shortenHomeInString(notice.message),
      })),
      configurationWarnings: Array.from(pluginConfigWarnings, shortenHomeInString),
    });
    return;
  }

  const healthyMessage =
    "Plugin discovery, module loading, compatibility, and configuration checks passed. " +
    'Run "openclaw health" to check the running Gateway, including runtime quarantines and fallbacks.';
  if (!hasInstallTreeIssues && pluginConfigWarnings.size === 0 && compatibility.length === 0) {
    defaultRuntime.log(healthyMessage);
    return;
  }

  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(theme.error("Plugin errors:"));
    for (const entry of errors) {
      const phase = entry.failurePhase ? ` [${entry.failurePhase}]` : "";
      lines.push(`- ${entry.id}${phase}: ${entry.error ?? "failed to load"} (${entry.source})`);
    }
  }
  if (diags.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(theme.warn("Diagnostics:"));
    for (const diag of diags) {
      const target = diag.pluginId ? `${diag.pluginId}: ` : "";
      lines.push(`- ${target}${diag.message}`);
    }
  }
  if (shadowed.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(theme.warn("Plugin source shadowing:"));
    for (const diag of shadowed) {
      const active = report.plugins.find((plugin) => plugin.id === diag.pluginId);
      const target = diag.pluginId ? `${diag.pluginId}: ` : "";
      lines.push(`- ${target}${diag.message}`);
      if (active) {
        lines.push(`  active: ${shortenHomeInString(active.source)} (${active.origin})`);
        if (active.status === "error") {
          lines.push(`  active status: error${active.error ? `: ${active.error}` : ""}`);
        }
      }
      if (diag.source) {
        lines.push(`  shadowed: ${shortenHomeInString(diag.source)}`);
      }
      lines.push("  repair:");
      lines.push("    openclaw plugins inspect " + (diag.pluginId ?? "<plugin-id>"));
      lines.push("    edit or remove the config-selected plugin source");
      lines.push("    openclaw plugins registry --refresh");
      lines.push("    openclaw gateway restart --force");
    }
  }
  if (compatibility.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(theme.warn("Compatibility:"));
    for (const notice of compatibility) {
      const marker = notice.severity === "warn" ? theme.warn("warn") : theme.muted("info");
      lines.push(`- ${formatPluginCompatibilityNotice(notice)} [${marker}]`);
    }
  }
  if (pluginConfigWarnings.size > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(theme.warn("Plugin configuration:"), ...pluginConfigWarnings);
  }
  if (!hasInstallTreeIssues) {
    const summary = pluginConfigWarnings.size
      ? "No plugin install-tree issues detected; configuration warnings remain."
      : healthyMessage;
    lines.push("", summary);
  }
  const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
  lines.push("");
  lines.push(`${theme.muted("Docs:")} ${docs}`);
  defaultRuntime.log(lines.join("\n"));
}

type MarketplaceRefreshPayload = {
  source: "hosted" | "hosted-snapshot" | "bundled-fallback";
  entries: number;
  feed?: {
    id: string;
    generatedAt: string;
    sequence: number;
  };
  metadata?: {
    url: string;
    status: number;
    etag?: string;
    lastModified?: string;
    checksum?: string;
  };
  snapshot?: {
    savedAt: string;
  };
  trust?: MarketplaceFeedTrustPayload;
  error?: string;
};

type MarketplaceFeedTrustPayload = {
  mode: "signed";
  signedBy: string;
  signatureCount: number;
  threshold: number;
  verifiedAt: string;
};

type MarketplaceEntryPayload = {
  id?: string;
  label: string;
  kind?: string;
  name?: string;
  version?: string;
  install?: {
    defaultChoice?: string;
    clawhubSpec?: string;
    npmSpec?: string;
    localPath?: string;
    expectedIntegrity?: string;
    minHostVersion?: string;
  };
};

type MarketplaceFeedTelemetryOptions = {
  expectedSha256?: string;
  feedProfile?: string;
  feedUrl?: string;
  offline?: boolean;
};

function classifyMarketplaceFeedFallback(error: string | undefined): string | undefined {
  const text = error?.toLowerCase();
  if (!text) {
    return undefined;
  }
  const categories = [
    [/offline mode/u, "offline"],
    [/checksum mismatch/u, "checksum_mismatch"],
    [/schema/u, "schema"],
    [/http\s+304/u, "not_modified"],
    [/http\s+\d{3}/u, "http_error"],
    [/timed out|timeout/u, "timeout"],
  ] as const;
  return categories.find(([pattern]) => pattern.test(text))?.[1] ?? "error";
}

function emitMarketplaceFeedTelemetry(params: {
  command: "entries" | "refresh";
  entryCount?: number;
  failedPinnedRefresh?: boolean;
  opts: MarketplaceFeedTelemetryOptions;
  config?: OpenClawConfig;
  payload: MarketplaceRefreshPayload;
}): void {
  const attributes: Record<string, string | number | boolean | null> = {
    command: params.command,
    entries: params.entryCount ?? params.payload.entries,
    source: params.payload.source,
  };
  if (params.opts.feedProfile?.trim()) {
    attributes.feedProfileProvided = true;
  }
  if (params.opts.feedUrl?.trim()) {
    attributes.feedUrlOverride = true;
  }
  if (params.opts.offline === true) {
    attributes.offline = true;
  }
  if (params.opts.expectedSha256?.trim()) {
    attributes.expectedSha256Provided = true;
  }
  if (params.payload.feed) {
    attributes.feedIdPresent = true;
    attributes.feedSequence = params.payload.feed.sequence;
  }
  if (params.payload.metadata) {
    attributes.httpStatus = params.payload.metadata.status;
    if (params.payload.metadata.checksum) {
      attributes.payloadChecksumPresent = true;
    }
    attributes.hasEtag = Boolean(params.payload.metadata.etag);
    attributes.hasLastModified = Boolean(params.payload.metadata.lastModified);
  }
  if (params.payload.snapshot) {
    attributes.snapshotUsed = true;
  }
  if (params.payload.trust) {
    attributes.feedTrustVerified = true;
    attributes.feedTrustMode = params.payload.trust.mode;
    attributes.feedTrustSignatureCount = params.payload.trust.signatureCount;
    attributes.feedTrustThreshold = params.payload.trust.threshold;
  }
  const fallbackCategory = classifyMarketplaceFeedFallback(params.payload.error);
  if (fallbackCategory) {
    attributes.fallbackCategory = fallbackCategory;
  }
  if (params.failedPinnedRefresh === true) {
    attributes.pinnedRefreshFailed = true;
  }
  emitDiagnosticsTimelineEvent(
    {
      type: "mark",
      name: `plugins.marketplace.feed.${params.command}`,
      phase: "plugin-marketplace",
      attributes,
    },
    {
      config: params.config,
    },
  );
}

function buildMarketplaceRefreshPayload(
  result: Awaited<
    ReturnType<
      typeof import("../plugins/official-external-plugin-catalog.js").loadConfiguredHostedOfficialExternalPluginCatalogEntries
    >
  >,
): MarketplaceRefreshPayload {
  const payload: MarketplaceRefreshPayload = {
    source: result.source,
    entries: result.entries.length,
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
  if (result.source === "hosted" || result.source === "hosted-snapshot") {
    payload.feed = {
      id: result.feed.id,
      generatedAt: result.feed.generatedAt,
      sequence: result.feed.sequence,
    };
    if (result.trust) {
      payload.trust = {
        mode: result.trust.mode,
        signedBy: result.trust.signedBy,
        signatureCount: result.trust.signatureCount,
        threshold: result.trust.threshold,
        verifiedAt: result.trust.verifiedAt,
      };
    }
  }
  if (result.source === "hosted-snapshot") {
    payload.snapshot = { savedAt: result.snapshot.savedAt };
    payload.error = result.error;
  }
  if (result.source === "bundled-fallback") {
    payload.error = result.error;
  }
  return payload;
}

function redactMarketplaceFeedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function redactMarketplaceOutputText(
  value: string,
  rawUrls: readonly (string | undefined)[],
): string {
  let redacted = value;
  for (const rawUrl of rawUrls) {
    if (!rawUrl) {
      continue;
    }
    redacted = redacted.replaceAll(rawUrl, () => redactMarketplaceFeedUrl(rawUrl));
  }
  return redacted;
}

function sanitizeMarketplaceRefreshPayload(
  payload: MarketplaceRefreshPayload,
  params?: { feedUrl?: string },
): MarketplaceRefreshPayload {
  const rawMetadataUrl = payload.metadata?.url;
  const sanitized: MarketplaceRefreshPayload = {
    ...payload,
    ...(payload.metadata
      ? { metadata: { ...payload.metadata, url: redactMarketplaceFeedUrl(payload.metadata.url) } }
      : {}),
  };
  if (payload.error) {
    sanitized.error = redactMarketplaceOutputText(payload.error, [params?.feedUrl, rawMetadataUrl]);
  }
  return sanitized;
}

function formatMarketplaceEntryInstall(entry: MarketplaceEntryPayload): string | undefined {
  if (entry.install?.defaultChoice === "npm") {
    return entry.install.npmSpec ?? entry.install.clawhubSpec ?? entry.install.localPath;
  }
  return entry.install?.clawhubSpec ?? entry.install?.npmSpec ?? entry.install?.localPath;
}

function formatMarketplaceEntryLine(entry: MarketplaceEntryPayload): string {
  const id = entry.id ?? entry.name ?? entry.label;
  const install = formatMarketplaceEntryInstall(entry);
  const suffix = install ? " " + theme.muted(install) : "";
  const label = entry.label !== id ? " " + theme.muted(entry.label) : "";
  return theme.command(id) + label + suffix;
}

function formatMarketplaceRefreshSource(source: MarketplaceRefreshPayload["source"]): string {
  if (source === "hosted") {
    return theme.success("hosted");
  }
  if (source === "hosted-snapshot") {
    return theme.warn("hosted snapshot");
  }
  return theme.warn("bundled fallback");
}

function formatMarketplaceFeedTrust(trust: MarketplaceFeedTrustPayload): string {
  return `${trust.mode} by ${trust.signedBy} (${trust.signatureCount}/${trust.threshold}) verified ${trust.verifiedAt}`;
}

function formatMarketplaceFeedLines(
  payload: MarketplaceRefreshPayload,
  options: { includeChecksum?: boolean } = {},
): string[] {
  const lines = [
    `${theme.muted("Source:")} ${formatMarketplaceRefreshSource(payload.source)}`,
    `${theme.muted("Entries:")} ${payload.entries}`,
  ];
  if (payload.feed) {
    lines.push(
      `${theme.muted("Feed:")} ${payload.feed.id} ${theme.muted(`sequence ${payload.feed.sequence}`)}`,
    );
  }
  if (payload.metadata?.url) {
    lines.push(`${theme.muted("URL:")} ${payload.metadata.url}`);
  }
  if (options.includeChecksum && payload.metadata?.checksum) {
    lines.push(`${theme.muted("SHA-256:")} ${payload.metadata.checksum}`);
  }
  if (payload.snapshot?.savedAt) {
    lines.push(`${theme.muted("Snapshot:")} ${payload.snapshot.savedAt}`);
  }
  if (payload.trust) {
    lines.push(`${theme.muted("Trust:")} ${formatMarketplaceFeedTrust(payload.trust)}`);
  }
  if (payload.error) {
    lines.push(`${theme.muted("Fallback reason:")} ${payload.error}`);
  }
  return lines;
}

function shouldFailPinnedMarketplaceRefresh(params: {
  expectedSha256?: string;
  source: MarketplaceRefreshPayload["source"];
}): boolean {
  return Boolean(params.expectedSha256?.trim()) && params.source !== "hosted";
}

function normalizeMarketplaceExpectedSha256(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    return `sha256:${trimmed.toLowerCase()}`;
  }
  const prefixed = /^sha256:([0-9a-f]{64})$/iu.exec(trimmed);
  if (prefixed?.[1]) {
    return `sha256:${prefixed[1].toLowerCase()}`;
  }
  return trimmed;
}

function formatPinnedMarketplaceRefreshFailure(payload: MarketplaceRefreshPayload): string {
  return `Pinned marketplace feed refresh did not accept a fresh hosted payload (source: ${payload.source}).`;
}

const MARKETPLACE_GATEWAY_RESTART_GUIDANCE =
  'The running Gateway could not refresh its marketplace catalog. Run "openclaw gateway restart" to apply the current catalog state.';

/** List entries from the configured OpenClaw marketplace feed. */
export async function runPluginMarketplaceEntriesCommand(
  opts: PluginMarketplaceEntriesOptions,
): Promise<void> {
  const catalog = await import("../plugins/official-external-plugin-catalog.js");
  const cfg = getRuntimeConfig();
  const result = await catalog.loadConfiguredHostedOfficialExternalPluginCatalogEntries({
    ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
    ...(opts.feedUrl ? { feedUrl: opts.feedUrl } : {}),
    ...(opts.offline ? { offline: true } : {}),
  });
  const summary = sanitizeMarketplaceRefreshPayload(buildMarketplaceRefreshPayload(result), {
    feedUrl: opts.feedUrl,
  });
  const entries: MarketplaceEntryPayload[] = result.entries.map((entry) => {
    const id = catalog.resolveOfficialExternalPluginId(entry);
    const install = catalog.resolveOfficialExternalPluginInstall(entry) ?? undefined;
    const payload: MarketplaceEntryPayload = {
      label: catalog.resolveOfficialExternalPluginLabel(entry),
    };
    if (id) {
      payload.id = id;
    }
    if (entry.kind) {
      payload.kind = entry.kind;
    }
    if (entry.name) {
      payload.name = entry.name;
    }
    if (entry.version) {
      payload.version = entry.version;
    }
    if (install) {
      payload.install = install;
    }
    return payload;
  });

  emitMarketplaceFeedTelemetry({
    command: "entries",
    entryCount: entries.length,
    opts,
    config: cfg,
    payload: summary,
  });
  if (opts.json) {
    defaultRuntime.writeJson({ ...summary, entries, entryCount: entries.length });
    return;
  }

  const lines = formatMarketplaceFeedLines(summary);
  if (entries.length > 0) {
    lines.push("");
    lines.push(...entries.map(formatMarketplaceEntryLine));
  }
  defaultRuntime.log(lines.join("\n"));
}

/** Refresh the configured OpenClaw marketplace feed snapshot. */
export async function runPluginMarketplaceRefreshCommand(
  opts: PluginMarketplaceRefreshOptions,
): Promise<void> {
  const { loadConfiguredHostedOfficialExternalPluginCatalogEntries } =
    await import("../plugins/official-external-plugin-catalog.js");
  const cfg = getRuntimeConfig();
  const expectedSha256 = normalizeMarketplaceExpectedSha256(opts.expectedSha256);
  const result = await loadConfiguredHostedOfficialExternalPluginCatalogEntries({
    ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
    ...(opts.feedUrl ? { feedUrl: opts.feedUrl } : {}),
    ...(expectedSha256 ? { expectedSha256 } : {}),
    requireSnapshotWrite: true,
  });
  const { clearManagedPluginOfficialCatalogCache } =
    await import("../plugins/management-service.js");
  clearManagedPluginOfficialCatalogCache();
  let gatewayRefreshed = true;
  // Reused snapshots can lose install authority as they age, so their Gateway projection is stale too.
  if (result.source !== "bundled-fallback") {
    const { notifyGatewayPluginMetadataChanged } =
      await import("./plugins-update-gateway-signal.js");
    gatewayRefreshed = await notifyGatewayPluginMetadataChanged(cfg);
  }
  const payload = sanitizeMarketplaceRefreshPayload(buildMarketplaceRefreshPayload(result), {
    feedUrl: opts.feedUrl,
  });

  const failedPinnedRefresh = shouldFailPinnedMarketplaceRefresh({
    expectedSha256,
    source: payload.source,
  });
  emitMarketplaceFeedTelemetry({
    command: "refresh",
    failedPinnedRefresh,
    opts,
    config: cfg,
    payload,
  });

  if (opts.json) {
    defaultRuntime.writeJson(payload);
    if (!gatewayRefreshed) {
      defaultRuntime.error(MARKETPLACE_GATEWAY_RESTART_GUIDANCE);
    }
    if (failedPinnedRefresh) {
      defaultRuntime.error(formatPinnedMarketplaceRefreshFailure(payload));
      return defaultRuntime.exit(1);
    }
    return;
  }

  const lines = formatMarketplaceFeedLines(payload, { includeChecksum: true });
  if (!gatewayRefreshed) {
    lines.push("", theme.warn(MARKETPLACE_GATEWAY_RESTART_GUIDANCE));
  }
  defaultRuntime.log(lines.join("\n"));
  if (failedPinnedRefresh) {
    defaultRuntime.error(formatPinnedMarketplaceRefreshFailure(payload));
    return defaultRuntime.exit(1);
  }
}

/** List plugins from a configured marketplace manifest. */
export async function runPluginMarketplaceListCommand(
  source: string,
  opts: PluginMarketplaceListOptions,
): Promise<void> {
  const { listMarketplacePlugins } = await import("../plugins/marketplace.js");
  const { createPluginInstallLogger, quietPluginJsonLogger } = await loadPluginsCommandHelpers();
  const result = await listMarketplacePlugins({
    marketplace: source,
    logger: opts.json ? quietPluginJsonLogger : createPluginInstallLogger(),
  });
  if (!result.ok) {
    const message = result.error;
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }

  if (opts.json) {
    return defaultRuntime.writeJson({
      source: result.sourceLabel,
      name: result.manifest.name,
      version: result.manifest.version,
      plugins: result.manifest.plugins,
    });
  }

  if (result.manifest.plugins.length === 0) {
    defaultRuntime.log(`No plugins found in marketplace ${result.sourceLabel}.`);
    return;
  }

  defaultRuntime.log(
    `${theme.heading("Marketplace")} ${theme.muted(result.manifest.name ?? result.sourceLabel)}`,
  );
  for (const plugin of result.manifest.plugins) {
    const suffix = plugin.version ? theme.muted(` v${plugin.version}`) : "";
    const desc = plugin.description ? ` - ${theme.muted(plugin.description)}` : "";
    defaultRuntime.log(`${theme.command(plugin.name)}${suffix}${desc}`);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
