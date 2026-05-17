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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomeInString } from "../utils.js";
import { formatMissingPluginMessage } from "./error-format.js";
import type { PluginMarketplaceListOptions, PluginRegistryOptions } from "./plugins-cli.js";

type PluginInstallActionOptions = {
  dangerouslyForceUnsafeInstall?: boolean;
  force?: boolean;
  link?: boolean;
  pin?: boolean;
  marketplace?: string;
};

function countEnabledPlugins(plugins: readonly { enabled: boolean }[]): number {
  return plugins.filter((plugin) => plugin.enabled).length;
}

function formatRegistryState(state: "missing" | "fresh" | "stale"): string {
  if (state === "fresh") {
    return theme.success(state);
  }
  if (state === "stale") {
    return theme.warn(state);
  }
  return theme.warn(state);
}

function reportMissingPlugin(id: string) {
  defaultRuntime.error(formatMissingPluginMessage({ id, includeSearch: true }));
  return defaultRuntime.exit(1);
}

function matchesPluginId(plugin: { id: string }, id: string) {
  return plugin.id === id;
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
    pluginId === "acpx" ? "disable ACP/acpx in acp config" : 'change the runtime policy to "pi"';
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
      : 'change the runtime policy to "pi"';
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(params.pluginId)) {
    return `Add "${params.pluginId}" to plugins.allow and enable the plugin, or ${alternative}.`;
  }
  return `Enable the "${params.pluginId}" plugin, or ${alternative}.`;
}

function collectConfiguredRuntimePluginWarnings(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  plugins: readonly { enabled?: boolean; id: string; status?: string }[];
}): string[] {
  const enabledPluginIds = new Set(
    params.plugins
      .filter((plugin) => plugin.enabled !== false && plugin.status !== "disabled")
      .map((plugin) => plugin.id),
  );
  return collectConfiguredRuntimePluginIds(params.cfg, params.env, {
    includeEnvRuntime: false,
    includeImplicitRuntimePreferences: false,
    includeLegacyAgentRuntimes: false,
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

export async function runPluginsEnableCommand(id: string): Promise<void> {
  assertConfigWriteAllowedInCurrentMode();

  const { enablePluginInConfig } = await import("../plugins/enable.js");
  const { normalizePluginId } = await import("../plugins/config-state.js");
  const { buildPluginRegistrySnapshotReport } = await import("../plugins/status.js");
  const { applySlotSelectionForPlugin, logSlotWarnings } =
    await import("./plugins-command-helpers.js");
  const { refreshPluginRegistryAfterConfigMutation } =
    await import("./plugins-registry-refresh.js");
  const snapshot = await readConfigFileSnapshot();
  const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const report = buildPluginRegistrySnapshotReport({ config: cfg });
  id = normalizePluginId(id);
  if (!report.plugins.some((plugin) => matchesPluginId(plugin, id))) {
    return reportMissingPlugin(id);
  }
  const enableResult = enablePluginInConfig(cfg, id, {
    updateChannelConfig: false,
  });
  let next: OpenClawConfig = enableResult.config;
  const slotResult = applySlotSelectionForPlugin(next, id);
  next = slotResult.config;
  await replaceConfigFile({
    nextConfig: next,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });
  await refreshPluginRegistryAfterConfigMutation({
    config: next,
    reason: "policy-changed",
    policyPluginIds: [enableResult.pluginId],
    logger: {
      warn: (message) => defaultRuntime.log(theme.warn(message)),
    },
  });
  logSlotWarnings(slotResult.warnings);
  if (enableResult.enabled) {
    defaultRuntime.log(`Enabled plugin "${id}". Restart the gateway to apply.`);
    return;
  }
  defaultRuntime.log(
    theme.warn(`Plugin "${id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`),
  );
}

export async function runPluginsDisableCommand(id: string): Promise<void> {
  assertConfigWriteAllowedInCurrentMode();

  const { normalizePluginId } = await import("../plugins/config-state.js");
  const { buildPluginRegistrySnapshotReport } = await import("../plugins/status.js");
  const { setPluginEnabledInConfig } = await import("./plugins-config.js");
  const { refreshPluginRegistryAfterConfigMutation } =
    await import("./plugins-registry-refresh.js");
  const snapshot = await readConfigFileSnapshot();
  const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const report = buildPluginRegistrySnapshotReport({ config: cfg });
  id = normalizePluginId(id);
  if (!report.plugins.some((plugin) => matchesPluginId(plugin, id))) {
    return reportMissingPlugin(id);
  }
  const next = setPluginEnabledInConfig(cfg, id, false, {
    updateChannelConfig: false,
  });
  await replaceConfigFile({
    nextConfig: next,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });
  await refreshPluginRegistryAfterConfigMutation({
    config: next,
    reason: "policy-changed",
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
      await runPluginInstallCommand({ raw, opts });
    },
    { command: "install" },
  );
}

export async function runPluginsRegistryCommand(opts: PluginRegistryOptions): Promise<void> {
  const { inspectPluginRegistry, refreshPluginRegistry } =
    await import("../plugins/plugin-registry.js");
  const cfg = getRuntimeConfig();

  if (opts.refresh) {
    const index = await refreshPluginRegistry({
      config: cfg,
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
    return;
  }

  const inspection = await inspectPluginRegistry({ config: cfg });
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

export async function runPluginsDoctorCommand(): Promise<void> {
  const {
    buildPluginCompatibilityNotices,
    buildPluginDiagnosticsReport,
    formatPluginCompatibilityNotice,
  } = await import("../plugins/status.js");
  const {
    collectStalePluginConfigWarnings,
    isStalePluginAutoRepairBlocked,
    scanStalePluginConfig,
  } = await import("../commands/doctor/shared/stale-plugin-config.js");
  const cfg = getRuntimeConfig();
  const configSnapshot = await readConfigFileSnapshot().catch(() => null);
  const sourceCfg = (configSnapshot?.sourceConfig ?? configSnapshot?.config ?? cfg) as
    | OpenClawConfig
    | undefined;
  const report = buildPluginDiagnosticsReport({ config: cfg, effectiveOnly: true });
  const errors = report.plugins.filter((p) => p.status === "error");
  const diags = report.diagnostics.filter((d) => d.level === "error");
  const shadowed = report.diagnostics.filter((entry) =>
    isErroredConfigSelectedShadowDiagnostic({ entry, plugins: report.plugins }),
  );
  const compatibility = buildPluginCompatibilityNotices({ report });
  const stalePluginConfigHits = scanStalePluginConfig(sourceCfg ?? cfg, process.env);
  const stalePluginConfigWarnings = collectStalePluginConfigWarnings({
    hits: stalePluginConfigHits,
    doctorFixCommand: "openclaw doctor --fix",
    autoRepairBlocked: isStalePluginAutoRepairBlocked(sourceCfg ?? cfg, process.env),
  });
  const configuredRuntimePluginWarnings = collectConfiguredRuntimePluginWarnings({
    cfg: sourceCfg ?? cfg,
    env: process.env,
    plugins: report.plugins,
  });
  const hasInstallTreeIssues =
    errors.length > 0 || diags.length > 0 || shadowed.length > 0 || compatibility.length > 0;
  const pluginConfigWarnings = [...stalePluginConfigWarnings, ...configuredRuntimePluginWarnings];

  if (!hasInstallTreeIssues && pluginConfigWarnings.length === 0) {
    defaultRuntime.log("No plugin issues detected.");
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
  if (pluginConfigWarnings.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(theme.warn("Plugin configuration:"));
    lines.push(...pluginConfigWarnings);
  }
  if (!hasInstallTreeIssues && pluginConfigWarnings.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("No plugin install-tree issues detected; configuration warnings remain.");
  }
  const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
  lines.push("");
  lines.push(`${theme.muted("Docs:")} ${docs}`);
  defaultRuntime.log(lines.join("\n"));
}

export async function runPluginMarketplaceListCommand(
  source: string,
  opts: PluginMarketplaceListOptions,
): Promise<void> {
  const { listMarketplacePlugins } = await import("../plugins/marketplace.js");
  const { createPluginInstallLogger } = await import("./plugins-command-helpers.js");
  const result = await listMarketplacePlugins({
    marketplace: source,
    logger: createPluginInstallLogger(),
  });
  if (!result.ok) {
    defaultRuntime.error(result.error);
    return defaultRuntime.exit(1);
  }

  if (opts.json) {
    defaultRuntime.writeJson({
      source: result.sourceLabel,
      name: result.manifest.name,
      version: result.manifest.version,
      plugins: result.manifest.plugins,
    });
    return;
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
