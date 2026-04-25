import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { loadConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { listMarketplacePlugins } from "../plugins/marketplace.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { formatPluginSourceForTable, resolvePluginSourceRoots } from "../plugins/source-display.js";
import {
  buildAllPluginInspectReports,
  buildPluginDiagnosticsReport,
  buildPluginCompatibilityNotices,
  buildPluginInspectReport,
  buildPluginSnapshotReport,
  formatPluginCompatibilityNotice,
} from "../plugins/status.js";
import type { PluginLogger } from "../plugins/types.js";
import {
  resolveUninstallChannelConfigKeys,
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
} from "../plugins/uninstall.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import {
  applySlotSelectionForPlugin,
  createPluginInstallLogger,
  logSlotWarnings,
} from "./plugins-command-helpers.js";
import { setPluginEnabledInConfig } from "./plugins-config.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";
import { formatPluginLine } from "./plugins-list-format.js";
import { resolvePluginUninstallId } from "./plugins-uninstall-selection.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";
import { promptYesNo } from "./prompt.js";

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
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
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
    .action((opts: PluginsListOptions) => {
      const report = buildPluginSnapshotReport(
        opts.json ? { logger: quietPluginJsonLogger } : undefined,
      );
      const list = opts.enabled
        ? report.plugins.filter((p) => p.status === "loaded")
        : report.plugins;

      if (opts.json) {
        const payload = {
          workspaceDir: report.workspaceDir,
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

      const loaded = list.filter((p) => p.status === "loaded").length;
      defaultRuntime.log(
        `${theme.heading("Plugins")} ${theme.muted(`(${loaded}/${list.length} loaded)`)}`,
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
              plugin.status === "loaded"
                ? theme.success("loaded")
                : plugin.status === "disabled"
                  ? theme.warn("disabled")
                  : theme.error("error"),
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
    .command("inspect")
    .alias("info")
    .description("Inspect plugin details")
    .argument("[id]", "Plugin id")
    .option("--all", "Inspect all plugins")
    .option("--json", "Print JSON")
    .action((id: string | undefined, opts: PluginInspectOptions) => {
      const cfg = loadConfig();
      const report = buildPluginDiagnosticsReport({
        config: cfg,
        ...(opts.json ? { logger: quietPluginJsonLogger } : {}),
      });
      if (opts.all) {
        if (id) {
          defaultRuntime.error("Pass either a plugin id or --all, not both.");
          return defaultRuntime.exit(1);
        }
        const inspectAll = buildAllPluginInspectReports({
          config: cfg,
          ...(opts.json ? { logger: quietPluginJsonLogger } : {}),
          report,
        });
        const inspectAllWithInstall = inspectAll.map((inspect) => ({
          ...inspect,
          install: cfg.plugins?.installs?.[inspect.plugin.id],
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

      const inspect = buildPluginInspectReport({
        id,
        config: cfg,
        ...(opts.json ? { logger: quietPluginJsonLogger } : {}),
        report,
      });
      if (!inspect) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        return defaultRuntime.exit(1);
      }
      const install = cfg.plugins?.installs?.[inspect.plugin.id];

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
      const snapshot = await readConfigFileSnapshot();
      const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
      const next = setPluginEnabledInConfig(cfg, id, false);
      await replaceConfigFile({
        nextConfig: next,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
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
      const snapshot = await readConfigFileSnapshot();
      const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
      const report = buildPluginDiagnosticsReport({ config: cfg });
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

      const install = cfg.plugins?.installs?.[pluginId];
      const isLinked = install?.source === "path";
      const preview: string[] = [];
      if (hasEntry) {
        preview.push("config entry");
      }
      if (hasInstall) {
        preview.push("install record");
      }
      if (cfg.plugins?.allow?.includes(pluginId)) {
        preview.push("allowlist entry");
      }
      if (
        isLinked &&
        install?.sourcePath &&
        cfg.plugins?.load?.paths?.includes(install.sourcePath)
      ) {
        preview.push("load path");
      }
      if (cfg.plugins?.slots?.memory === pluginId) {
        preview.push(`memory slot (will reset to "${defaultSlotIdForKey("memory")}")`);
      }
      const channelIds = plugin?.status === "loaded" ? plugin.channelIds : undefined;
      const channels = cfg.channels as Record<string, unknown> | undefined;
      if (hasInstall && channels) {
        for (const key of resolveUninstallChannelConfigKeys(pluginId, { channelIds })) {
          if (Object.hasOwn(channels, key)) {
            preview.push(`channel config (channels.${key})`);
          }
        }
      }
      const deleteTarget = !keepFiles
        ? resolveUninstallDirectoryTarget({
            pluginId,
            hasInstall,
            installRecord: install,
            extensionsDir,
          })
        : null;
      if (deleteTarget) {
        preview.push(`directory: ${shortenHomePath(deleteTarget)}`);
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

      const result = await uninstallPlugin({
        config: cfg,
        pluginId,
        channelIds,
        deleteFiles: !keepFiles,
        extensionsDir,
      });

      if (!result.ok) {
        defaultRuntime.error(result.error);
        return defaultRuntime.exit(1);
      }
      for (const warning of result.warnings) {
        defaultRuntime.log(theme.warn(warning));
      }

      await replaceConfigFile({
        nextConfig: result.config,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
      });

      const removed: string[] = [];
      if (result.actions.entry) {
        removed.push("config entry");
      }
      if (result.actions.install) {
        removed.push("install record");
      }
      if (result.actions.allowlist) {
        removed.push("allowlist");
      }
      if (result.actions.loadPath) {
        removed.push("load path");
      }
      if (result.actions.memorySlot) {
        removed.push("memory slot");
      }
      if (result.actions.channelConfig) {
        removed.push("channel config");
      }
      if (result.actions.directory) {
        removed.push("directory");
      }

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
        await runPluginInstallCommand({ raw, opts });
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
      await runPluginUpdateCommand({ id, opts });
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(() => {
      const report = buildPluginDiagnosticsReport();
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
}
