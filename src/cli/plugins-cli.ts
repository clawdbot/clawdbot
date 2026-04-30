import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { getRuntimeConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "../plugins/plugin-lifecycle-trace.js";
import { formatPluginSourceForTable, resolvePluginSourceRoots } from "../plugins/source-display.js";
import type { PluginLogger } from "../plugins/types.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatPluginLine } from "./plugins-list-format.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type PluginsListOptions = {
  json?: boolean;
  enabled?: boolean;
  verbose?: boolean;
};

export type PluginInspectOptions = {
  json?: boolean;
  all?: boolean;
};

export type PluginUpdateOptions = {
  all?: boolean;
  dryRun?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
};

export type PluginMarketplaceListOptions = {
  json?: boolean;
};

export type PluginUninstallOptions = {
  keepFiles?: boolean;
  /** @deprecated Use keepFiles. */
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

export type PluginRegistryOptions = {
  json?: boolean;
  refresh?: boolean;
};

export type PluginsDepsCliOptions = {
  json?: boolean;
  packageRoot?: string;
  prune?: boolean;
  repair?: boolean;
};

const quietPluginJsonLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function formatInspectSection(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return ["", theme.muted(`${title}:`), ...lines];
}

function formatCapabilityKinds(
  capabilities: Array<{
    kind: string;
  }>,
): string {
  if (capabilities.length === 0) {
    return "-";
  }
  return capabilities.map((entry) => entry.kind).join(", ");
}

function formatHookSummary(params: {
  usesLegacyBeforeAgentStart: boolean;
  typedHookCount: number;
  customHookCount: number;
}): string {
  const parts: string[] = [];
  if (params.usesLegacyBeforeAgentStart) {
    parts.push("before_agent_start");
  }
  const nonLegacyTypedHookCount =
    params.typedHookCount - (params.usesLegacyBeforeAgentStart ? 1 : 0);
  if (nonLegacyTypedHookCount > 0) {
    parts.push(`${nonLegacyTypedHookCount} typed`);
  }
  if (params.customHookCount > 0) {
    parts.push(`${params.customHookCount} custom`);
  }
  return parts.length > 0 ? parts.join(", ") : "-";
}

function formatInstallLines(install: PluginInstallRecord | undefined): string[] {
  if (!install) {
    return [];
  }
  const lines = [`Source: ${install.source}`];
  if (install.spec) {
    lines.push(`Spec: ${install.spec}`);
  }
  if (install.sourcePath) {
    lines.push(`Source path: ${shortenHomePath(install.sourcePath)}`);
  }
  if (install.installPath) {
    lines.push(`Install path: ${shortenHomePath(install.installPath)}`);
  }
  if (install.version) {
    lines.push(`Recorded version: ${install.version}`);
  }
  if (install.installedAt) {
    lines.push(`Installed at: ${install.installedAt}`);
  }
  return lines;
}

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

export function registerPluginsCli(program: Command) {
  const plugins = program
    .command("plugins")
    .description("Manage OpenClaw plugins and extensions")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/plugins", "docs.openclaw.ai/cli/plugins")}\n`,
    );

  plugins
    .command("list")
    .description("List discovered plugins")
    .option("--json", "Print JSON")
    .option("--enabled", "Only show enabled plugins", false)
    .option("--verbose", "Show detailed entries", false)
    .action(async (opts: PluginsListOptions) => {
      const { buildPluginRegistrySnapshotReport } = await import("../plugins/status.js");
      const cfg = getRuntimeConfig();
      const report = buildPluginRegistrySnapshotReport({
        config: cfg,
        ...(opts.json ? { logger: quietPluginJsonLogger } : {}),
      });
      const list = opts.enabled ? report.plugins.filter((p) => p.enabled) : report.plugins;

      if (opts.json) {
        const payload = {
          workspaceDir: report.workspaceDir,
          registry: {
            source: report.registrySource,
            diagnostics: report.registryDiagnostics,
          },
          plugins: list,
          diagnostics: report.diagnostics,
        };
        defaultRuntime.writeJson(payload);
        return;
      }

      if (list.length === 0) {
        defaultRuntime.log(theme.muted("No plugins found."));
        return;
      }

      const enabled = list.filter((p) => p.enabled).length;
      defaultRuntime.log(
        `${theme.heading("Plugins")} ${theme.muted(`(${enabled}/${list.length} enabled)`)}`,
      );

      if (!opts.verbose) {
        const tableWidth = getTerminalTableWidth();
        const sourceRoots = resolvePluginSourceRoots({
          workspaceDir: report.workspaceDir,
        });
        const usedRoots = new Set<keyof typeof sourceRoots>();
        const rows = list.map((plugin) => {
          const desc = plugin.description ? theme.muted(plugin.description) : "";
          const formattedSource = formatPluginSourceForTable(plugin, sourceRoots);
          if (formattedSource.rootKey) {
            usedRoots.add(formattedSource.rootKey);
          }
          const sourceLine = desc ? `${formattedSource.value}\n${desc}` : formattedSource.value;
          return {
            Name: plugin.name || plugin.id,
            ID: plugin.name && plugin.name !== plugin.id ? plugin.id : "",
            Format: plugin.format ?? "openclaw",
            Status:
              plugin.status === "error"
                ? theme.error("error")
                : plugin.enabled
                  ? theme.success("enabled")
                  : theme.warn("disabled"),
            Source: sourceLine,
            Version: plugin.version ?? "",
          };
        });

        if (usedRoots.size > 0) {
          defaultRuntime.log(theme.muted("Source roots:"));
          for (const key of ["stock", "workspace", "global"] as const) {
            if (!usedRoots.has(key)) {
              continue;
            }
            const dir = sourceRoots[key];
            if (!dir) {
              continue;
            }
            defaultRuntime.log(`  ${theme.command(`${key}:`)} ${theme.muted(dir)}`);
          }
          defaultRuntime.log("");
        }

        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Name", minWidth: 14, flex: true },
              { key: "ID", header: "ID", minWidth: 10, flex: true },
              { key: "Format", header: "Format", minWidth: 9 },
              { key: "Status", header: "Status", minWidth: 10 },
              { key: "Source", header: "Source", minWidth: 26, flex: true },
              { key: "Version", header: "Version", minWidth: 8 },
            ],
            rows,
          }).trimEnd(),
        );
        return;
      }

      const lines: string[] = [];
      for (const plugin of list) {
        lines.push(formatPluginLine(plugin, true));
        lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    });

  plugins
    .command("deps")
    .description("Inspect or repair bundled plugin runtime dependencies")
    .option("--json", "Print JSON")
    .option("--package-root <path>", "OpenClaw package root to inspect")
    .option("--prune", "Prune stale unknown external runtime dependency roots", false)
    .option("--repair", "Install missing bundled runtime dependencies", false)
    .action(async (opts: PluginsDepsCliOptions) => {
      const { runPluginsDepsCommand } = await import("./plugins-deps-command.js");
      await runPluginsDepsCommand({
        config: getRuntimeConfig(),
        options: opts,
      });
    });

  plugins
    .command("inspect")
    .alias("info")
    .description("Inspect plugin details")
    .argument("[id]", "Plugin id")
    .option("--all", "Inspect all plugins")
    .option("--json", "Print JSON")
    .action(async (id: string | undefined, opts: PluginInspectOptions) => {
      const {
        buildAllPluginInspectReports,
        buildPluginDiagnosticsReport,
        buildPluginInspectReport,
        buildPluginSnapshotReport,
        formatPluginCompatibilityNotice,
      } = await import("../plugins/status.js");
      const { loadInstalledPluginIndexInstallRecords } =
        await import("../plugins/installed-plugin-index-records.js");
      const cfg = tracePluginLifecyclePhase("config read", () => getRuntimeConfig(), {
        command: "inspect",
      });
      const installRecords = await tracePluginLifecyclePhaseAsync(
        "install records load",
        () => loadInstalledPluginIndexInstallRecords(),
        { command: "inspect" },
      );
      const loggerParams = opts.json ? { logger: quietPluginJsonLogger } : {};
      if (opts.all) {
        if (id) {
          defaultRuntime.error("Pass either a plugin id or --all, not both.");
          return defaultRuntime.exit(1);
        }
        const report = tracePluginLifecyclePhase(
          "runtime plugin registry load",
          () =>
            buildPluginDiagnosticsReport({
              config: cfg,
              ...loggerParams,
            }),
          { command: "inspect", all: true },
        );
        const inspectAll = buildAllPluginInspectReports({
          config: cfg,
          ...loggerParams,
          report,
        });
        const inspectAllWithInstall = inspectAll.map((inspect) => ({
          ...inspect,
          install: installRecords[inspect.plugin.id],
        }));

        if (opts.json) {
          defaultRuntime.writeJson(inspectAllWithInstall);
          return;
        }

        const tableWidth = getTerminalTableWidth();
        const rows = inspectAll.map((inspect) => ({
          Name: inspect.plugin.name || inspect.plugin.id,
          ID:
            inspect.plugin.name && inspect.plugin.name !== inspect.plugin.id
              ? inspect.plugin.id
              : "",
          Status:
            inspect.plugin.status === "loaded"
              ? theme.success("loaded")
              : inspect.plugin.status === "disabled"
                ? theme.warn("disabled")
                : theme.error("error"),
          Shape: inspect.shape,
          Capabilities: formatCapabilityKinds(inspect.capabilities),
          Compatibility:
            inspect.compatibility.length > 0
              ? inspect.compatibility
                  .map((entry) => (entry.severity === "warn" ? `warn:${entry.code}` : entry.code))
                  .join(", ")
              : "none",
          Bundle:
            inspect.bundleCapabilities.length > 0 ? inspect.bundleCapabilities.join(", ") : "-",
          Hooks: formatHookSummary({
            usesLegacyBeforeAgentStart: inspect.usesLegacyBeforeAgentStart,
            typedHookCount: inspect.typedHooks.length,
            customHookCount: inspect.customHooks.length,
          }),
        }));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Name", minWidth: 14, flex: true },
              { key: "ID", header: "ID", minWidth: 10, flex: true },
              { key: "Status", header: "Status", minWidth: 10 },
              { key: "Shape", header: "Shape", minWidth: 18 },
              { key: "Capabilities", header: "Capabilities", minWidth: 28, flex: true },
              { key: "Compatibility", header: "Compatibility", minWidth: 24, flex: true },
              { key: "Bundle", header: "Bundle", minWidth: 14, flex: true },
              { key: "Hooks", header: "Hooks", minWidth: 20, flex: true },
            ],
            rows,
          }).trimEnd(),
        );
        return;
      }

      if (!id) {
        defaultRuntime.error("Provide a plugin id or use --all.");
        return defaultRuntime.exit(1);
      }

      const snapshotReport = tracePluginLifecyclePhase(
        "plugin registry snapshot",
        () =>
          buildPluginSnapshotReport({
            config: cfg,
            ...loggerParams,
          }),
        { command: "inspect" },
      );
      const targetPlugin = snapshotReport.plugins.find(
        (entry) => entry.id === id || entry.name === id,
      );
      if (!targetPlugin) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        return defaultRuntime.exit(1);
      }
      const report = tracePluginLifecyclePhase(
        "runtime plugin registry load",
        () =>
          buildPluginDiagnosticsReport({
            config: cfg,
            ...loggerParams,
            onlyPluginIds: [targetPlugin.id],
          }),
        { command: "inspect", pluginId: targetPlugin.id },
      );
      const inspect = buildPluginInspectReport({
        id: targetPlugin.id,
        config: cfg,
        ...loggerParams,
        report,
      });
      if (!inspect) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        return defaultRuntime.exit(1);
      }
      const install = installRecords[inspect.plugin.id];

      if (opts.json) {
        defaultRuntime.writeJson({
          ...inspect,
          install,
        });
        return;
      }

      const lines: string[] = [];
      lines.push(theme.heading(inspect.plugin.name || inspect.plugin.id));
      if (inspect.plugin.name && inspect.plugin.name !== inspect.plugin.id) {
        lines.push(theme.muted(`id: ${inspect.plugin.id}`));
      }
      if (inspect.plugin.description) {
        lines.push(inspect.plugin.description);
      }
      lines.push("");
      lines.push(`${theme.muted("Status:")} ${inspect.plugin.status}`);
      if (inspect.plugin.failurePhase) {
        lines.push(`${theme.muted("Failure phase:")} ${inspect.plugin.failurePhase}`);
      }
      if (inspect.plugin.failedAt) {
        lines.push(`${theme.muted("Failed at:")} ${inspect.plugin.failedAt.toISOString()}`);
      }
      lines.push(`${theme.muted("Format:")} ${inspect.plugin.format ?? "openclaw"}`);
      if (inspect.plugin.bundleFormat) {
        lines.push(`${theme.muted("Bundle format:")} ${inspect.plugin.bundleFormat}`);
      }
      lines.push(`${theme.muted("Source:")} ${shortenHomeInString(inspect.plugin.source)}`);
      lines.push(`${theme.muted("Origin:")} ${inspect.plugin.origin}`);
      if (inspect.plugin.version) {
        lines.push(`${theme.muted("Version:")} ${inspect.plugin.version}`);
      }
      lines.push(`${theme.muted("Shape:")} ${inspect.shape}`);
      lines.push(`${theme.muted("Capability mode:")} ${inspect.capabilityMode}`);
      lines.push(
        `${theme.muted("Legacy before_agent_start:")} ${inspect.usesLegacyBeforeAgentStart ? "yes" : "no"}`,
      );
      if (inspect.bundleCapabilities.length > 0) {
        lines.push(
          `${theme.muted("Bundle capabilities:")} ${inspect.bundleCapabilities.join(", ")}`,
        );
      }
      lines.push(
        ...formatInspectSection(
          "Capabilities",
          inspect.capabilities.map(
            (entry) =>
              `${entry.kind}: ${entry.ids.length > 0 ? entry.ids.join(", ") : "(registered)"}`,
          ),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Typed hooks",
          inspect.typedHooks.map((entry) =>
            entry.priority == null ? entry.name : `${entry.name} (priority ${entry.priority})`,
          ),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Compatibility warnings",
          inspect.compatibility.map(formatPluginCompatibilityNotice),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Custom hooks",
          inspect.customHooks.map((entry) => `${entry.name}: ${entry.events.join(", ")}`),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Tools",
          inspect.tools.map((entry) => {
            const names = entry.names.length > 0 ? entry.names.join(", ") : "(anonymous)";
            return entry.optional ? `${names} [optional]` : names;
          }),
        ),
      );
      lines.push(...formatInspectSection("Commands", inspect.commands));
      lines.push(...formatInspectSection("CLI commands", inspect.cliCommands));
      lines.push(...formatInspectSection("Services", inspect.services));
      lines.push(...formatInspectSection("Gateway methods", inspect.gatewayMethods));
      lines.push(
        ...formatInspectSection(
          "MCP servers",
          inspect.mcpServers.map((entry) =>
            entry.hasStdioTransport ? entry.name : `${entry.name} (unsupported transport)`,
          ),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "LSP servers",
          inspect.lspServers.map((entry) =>
            entry.hasStdioTransport ? entry.name : `${entry.name} (unsupported transport)`,
          ),
        ),
      );
      if (inspect.httpRouteCount > 0) {
        lines.push(...formatInspectSection("HTTP routes", [String(inspect.httpRouteCount)]));
      }
      const policyLines: string[] = [];
      if (typeof inspect.policy.allowPromptInjection === "boolean") {
        policyLines.push(`allowPromptInjection: ${inspect.policy.allowPromptInjection}`);
      }
      if (typeof inspect.policy.allowConversationAccess === "boolean") {
        policyLines.push(`allowConversationAccess: ${inspect.policy.allowConversationAccess}`);
      }
      if (typeof inspect.policy.allowModelOverride === "boolean") {
        policyLines.push(`allowModelOverride: ${inspect.policy.allowModelOverride}`);
      }
      if (inspect.policy.hasAllowedModelsConfig) {
        policyLines.push(
          `allowedModels: ${
            inspect.policy.allowedModels.length > 0
              ? inspect.policy.allowedModels.join(", ")
              : "(configured but empty)"
          }`,
        );
      }
      lines.push(...formatInspectSection("Policy", policyLines));
      lines.push(
        ...formatInspectSection(
          "Diagnostics",
          inspect.diagnostics.map((entry) => `${entry.level.toUpperCase()}: ${entry.message}`),
        ),
      );
      lines.push(...formatInspectSection("Install", formatInstallLines(install)));
      if (inspect.plugin.error) {
        lines.push("", `${theme.error("Error:")} ${inspect.plugin.error}`);
      }
      defaultRuntime.log(lines.join("\n"));
    });

  plugins
    .command("enable")
    .description("Enable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const { enablePluginInConfig } = await import("../plugins/enable.js");
      const { applySlotSelectionForPlugin, logSlotWarnings } =
        await import("./plugins-command-helpers.js");
      const { refreshPluginRegistryAfterConfigMutation } =
        await import("./plugins-registry-refresh.js");
      const snapshot = await readConfigFileSnapshot();
      const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
      const enableResult = enablePluginInConfig(cfg, id);
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
        theme.warn(
          `Plugin "${id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`,
        ),
      );
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const { setPluginEnabledInConfig } = await import("./plugins-config.js");
      const { refreshPluginRegistryAfterConfigMutation } =
        await import("./plugins-registry-refresh.js");
      const snapshot = await readConfigFileSnapshot();
      const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
      const next = setPluginEnabledInConfig(cfg, id, false);
      await replaceConfigFile({
        nextConfig: next,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
      });
      await refreshPluginRegistryAfterConfigMutation({
        config: next,
        reason: "policy-changed",
        logger: {
          warn: (message) => defaultRuntime.log(theme.warn(message)),
        },
      });
      defaultRuntime.log(`Disabled plugin "${id}". Restart the gateway to apply.`);
    });

  plugins
    .command("uninstall")
    .description("Uninstall a plugin")
    .argument("<id>", "Plugin id")
    .option("--keep-files", "Keep installed files on disk", false)
    .option("--keep-config", "Deprecated alias for --keep-files", false)
    .option("--force", "Skip confirmation prompt", false)
    .option("--dry-run", "Show what would be removed without making changes", false)
    .action(async (id: string, opts: PluginUninstallOptions) => {
      const {
        loadInstalledPluginIndexInstallRecords,
        removePluginInstallRecordFromRecords,
        withoutPluginInstallRecords,
        withPluginInstallRecords,
      } = await import("../plugins/installed-plugin-index-records.js");
      const { buildPluginSnapshotReport } = await import("../plugins/status.js");
      const {
        applyPluginUninstallDirectoryRemoval,
        formatUninstallActionLabels,
        formatUninstallSlotResetPreview,
        planPluginUninstall,
        resolveUninstallChannelConfigKeys,
        UNINSTALL_ACTION_LABELS,
      } = await import("../plugins/uninstall.js");
      const { commitPluginInstallRecordsWithConfig } =
        await import("./plugins-install-record-commit.js");
      const { refreshPluginRegistryAfterConfigMutation } =
        await import("./plugins-registry-refresh.js");
      const { resolvePluginUninstallId } = await import("./plugins-uninstall-selection.js");
      const { promptYesNo } = await import("./prompt.js");
      const snapshot = await tracePluginLifecyclePhaseAsync(
        "config read",
        () => readConfigFileSnapshot(),
        { command: "uninstall" },
      );
      const sourceConfig = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
      const installRecords = await tracePluginLifecyclePhaseAsync(
        "install records load",
        () => loadInstalledPluginIndexInstallRecords(),
        { command: "uninstall" },
      );
      const cfg = withPluginInstallRecords(sourceConfig, installRecords);
      const report = tracePluginLifecyclePhase(
        "plugin registry snapshot",
        () => buildPluginSnapshotReport({ config: cfg }),
        { command: "uninstall" },
      );
      const extensionsDir = path.join(resolveStateDir(process.env, os.homedir), "extensions");
      const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);

      if (opts.keepConfig) {
        defaultRuntime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
      }

      const { plugin, pluginId } = resolvePluginUninstallId({
        rawId: id,
        config: cfg,
        plugins: report.plugins,
      });
      const hasEntry = pluginId in (cfg.plugins?.entries ?? {});
      const hasInstall = pluginId in (cfg.plugins?.installs ?? {});

      if (!hasEntry && !hasInstall) {
        if (plugin) {
          defaultRuntime.error(
            `Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`,
          );
        } else {
          defaultRuntime.error(`Plugin not found: ${id}`);
        }
        return defaultRuntime.exit(1);
      }

      const channelIds = plugin?.status === "loaded" ? plugin.channelIds : undefined;
      const plan = planPluginUninstall({
        config: cfg,
        pluginId,
        channelIds,
        deleteFiles: !keepFiles,
        extensionsDir,
      });
      if (!plan.ok) {
        defaultRuntime.error(plan.error);
        return defaultRuntime.exit(1);
      }

      const preview: string[] = [];
      if (plan.actions.entry) {
        preview.push(UNINSTALL_ACTION_LABELS.entry);
      }
      if (plan.actions.install) {
        preview.push(UNINSTALL_ACTION_LABELS.install);
      }
      if (plan.actions.allowlist) {
        preview.push(UNINSTALL_ACTION_LABELS.allowlist);
      }
      if (plan.actions.denylist) {
        preview.push(UNINSTALL_ACTION_LABELS.denylist);
      }
      if (plan.actions.loadPath) {
        preview.push(UNINSTALL_ACTION_LABELS.loadPath);
      }
      if (plan.actions.memorySlot) {
        preview.push(formatUninstallSlotResetPreview("memory"));
      }
      if (plan.actions.contextEngineSlot) {
        preview.push(formatUninstallSlotResetPreview("contextEngine"));
      }
      const channels = cfg.channels as Record<string, unknown> | undefined;
      if (plan.actions.channelConfig && hasInstall && channels) {
        for (const key of resolveUninstallChannelConfigKeys(pluginId, { channelIds })) {
          if (Object.hasOwn(channels, key)) {
            preview.push(`${UNINSTALL_ACTION_LABELS.channelConfig} (channels.${key})`);
          }
        }
      }
      if (plan.directoryRemoval) {
        preview.push(`directory: ${shortenHomePath(plan.directoryRemoval.target)}`);
      }

      const pluginName = plugin?.name || pluginId;
      defaultRuntime.log(
        `Plugin: ${theme.command(pluginName)}${pluginName !== pluginId ? theme.muted(` (${pluginId})`) : ""}`,
      );
      defaultRuntime.log(`Will remove: ${preview.length > 0 ? preview.join(", ") : "(nothing)"}`);

      if (opts.dryRun) {
        defaultRuntime.log(theme.muted("Dry run, no changes made."));
        return;
      }

      if (!opts.force) {
        const confirmed = await promptYesNo(`Uninstall plugin "${pluginId}"?`);
        if (!confirmed) {
          defaultRuntime.log("Cancelled.");
          return;
        }
      }

      const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
      const nextConfig = withoutPluginInstallRecords(plan.config);
      await tracePluginLifecyclePhaseAsync(
        "config mutation",
        () =>
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: installRecords,
            nextInstallRecords,
            nextConfig,
            ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
          }),
        { command: "uninstall" },
      );
      const directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
      for (const warning of directoryResult.warnings) {
        defaultRuntime.log(theme.warn(warning));
      }
      await refreshPluginRegistryAfterConfigMutation({
        config: nextConfig,
        reason: "source-changed",
        installRecords: nextInstallRecords,
        traceCommand: "uninstall",
        logger: {
          warn: (message) => defaultRuntime.log(theme.warn(message)),
        },
      });

      const removed = formatUninstallActionLabels({
        ...plan.actions,
        directory: directoryResult.directoryRemoved,
      });

      defaultRuntime.log(
        `Uninstalled plugin "${pluginId}". Removed: ${removed.length > 0 ? removed.join(", ") : "nothing"}.`,
      );
      defaultRuntime.log("Restart the gateway to apply changes.");
    });

  plugins
    .command("install")
    .description(
      "Install a plugin or hook pack (path, archive, npm spec, clawhub:package, or marketplace entry)",
    )
    .argument(
      "<path-or-spec-or-plugin>",
      "Path (.ts/.js/.zip/.tgz/.tar.gz), npm package spec, or marketplace plugin name",
    )
    .option("-l, --link", "Link a local path instead of copying", false)
    .option("--force", "Overwrite an existing installed plugin or hook pack", false)
    .option("--pin", "Record npm installs as exact resolved <name>@<version>", false)
    .option(
      "--dangerously-force-unsafe-install",
      "Bypass built-in dangerous-code install blocking (plugin hooks may still block)",
      false,
    )
    .option(
      "--marketplace <source>",
      "Install a Claude marketplace plugin from a local repo/path or git/GitHub source",
    )
    .action(
      async (
        raw: string,
        opts: {
          dangerouslyForceUnsafeInstall?: boolean;
          force?: boolean;
          link?: boolean;
          pin?: boolean;
          marketplace?: string;
        },
      ) => {
        await tracePluginLifecyclePhaseAsync(
          "install command",
          async () => {
            const { runPluginInstallCommand } = await import("./plugins-install-command.js");
            await runPluginInstallCommand({ raw, opts });
          },
          { command: "install" },
        );
      },
    );

  plugins
    .command("update")
    .description("Update installed plugins and tracked hook packs")
    .argument("[id]", "Plugin or hook-pack id (omit with --all)")
    .option("--all", "Update all tracked plugins and hook packs", false)
    .option("--dry-run", "Show what would change without writing", false)
    .option(
      "--dangerously-force-unsafe-install",
      "Bypass built-in dangerous-code update blocking for plugins (plugin hooks may still block)",
      false,
    )
    .action(async (id: string | undefined, opts: PluginUpdateOptions) => {
      const { runPluginUpdateCommand } = await import("./plugins-update-command.js");
      await runPluginUpdateCommand({ id, opts });
    });

  plugins
    .command("registry")
    .description("Inspect or rebuild the persisted plugin registry")
    .option("--json", "Print JSON")
    .option("--refresh", "Rebuild the persisted registry from current plugin manifests", false)
    .action(async (opts: PluginRegistryOptions) => {
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
        defaultRuntime.log(
          `Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`,
        );
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
        lines.push(
          `${theme.muted("Repair:")} ${theme.command("openclaw plugins registry --refresh")}`,
        );
      }
      defaultRuntime.log(lines.join("\n"));
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(async () => {
      const {
        buildPluginCompatibilityNotices,
        buildPluginDiagnosticsReport,
        formatPluginCompatibilityNotice,
      } = await import("../plugins/status.js");
      const report = buildPluginDiagnosticsReport({ effectiveOnly: true });
      const errors = report.plugins.filter((p) => p.status === "error");
      const diags = report.diagnostics.filter((d) => d.level === "error");
      const compatibility = buildPluginCompatibilityNotices({ report });

      if (errors.length === 0 && diags.length === 0 && compatibility.length === 0) {
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
      const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
      lines.push("");
      lines.push(`${theme.muted("Docs:")} ${docs}`);
      defaultRuntime.log(lines.join("\n"));
    });

  const marketplace = plugins
    .command("marketplace")
    .description("Inspect Claude-compatible plugin marketplaces");

  marketplace
    .command("list")
    .description("List plugins published by a marketplace source")
    .argument("<source>", "Local marketplace path/repo or git/GitHub source")
    .option("--json", "Print JSON")
    .action(async (source: string, opts: PluginMarketplaceListOptions) => {
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
    });

  applyParentDefaultHelpAction(plugins);
}
