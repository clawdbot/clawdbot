import type { Command } from "commander";
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
import type { PluginInspectOptions } from "./plugins-inspect-command.js";
import type { PluginsListOptions } from "./plugins-list-command.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type PluginUpdateOptions = {
  all?: boolean;
  acknowledgeClawhubRisk?: boolean;
  dryRun?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
};

type CommanderClawHubRiskOptions = Record<string, unknown> & {
  acknowledgeClawhubRisk?: boolean;
};

function normalizeCommanderClawHubRiskOption(opts: CommanderClawHubRiskOptions): boolean {
  return opts.acknowledgeClawhubRisk === true || opts.acknowledgeClawHubRisk === true;
}

export type PluginMarketplaceListOptions = {
  json?: boolean;
};

export type PluginSearchOptions = {
  json?: boolean;
  limit?: number;
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
      const { runPluginsListCommand } = await import("./plugins-list-command.js");
      await runPluginsListCommand(opts);
    });

  plugins
    .command("search")
    .description("Search ClawHub plugin packages")
    .argument("[query...]", "Search query")
    .option("--limit <n>", "Max results", (value) => Number.parseInt(value, 10))
    .option("--json", "Print JSON", false)
    .action(async (queryParts: string[], opts: PluginSearchOptions) => {
      const { runPluginsSearchCommand } = await import("./plugins-search-command.js");
      await runPluginsSearchCommand(queryParts, opts);
    });

  plugins
    .command("inspect")
    .alias("info")
    .description("Inspect plugin details")
    .argument("[id]", "Plugin id")
    .option("--all", "Inspect all plugins")
    .option("--runtime", "Load plugin runtime for hooks/tools/diagnostics")
    .option("--json", "Print JSON")
    .action(async (id: string | undefined, opts: PluginInspectOptions) => {
      const { runPluginsInspectCommand } = await import("./plugins-inspect-command.js");
      await runPluginsInspectCommand(id, opts);
    });

  plugins
    .command("enable")
    .description("Enable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
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
      const { runPluginUninstallCommand } = await import("./plugins-uninstall-command.js");
      await runPluginUninstallCommand(id, opts);
    });

  plugins
    .command("install")
    .description(
      "Install a plugin or hook pack (path, archive, npm spec, git repo, clawhub:package, or marketplace entry)",
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
      "--acknowledge-clawhub-risk",
      "Acknowledge ClawHub release trust warnings without prompting",
      false,
    )
    .option(
      "--marketplace <source>",
      "Install a Claude marketplace plugin from a local repo/path or git/GitHub source",
    )
    .action(
      async (
        raw: string,
        opts: CommanderClawHubRiskOptions & {
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
            await runPluginInstallCommand({
              raw,
              opts: {
                ...opts,
                acknowledgeClawHubRisk: normalizeCommanderClawHubRiskOption(opts),
              },
            });
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
    .option(
      "--acknowledge-clawhub-risk",
      "Acknowledge ClawHub release trust warnings without prompting",
      false,
    )
    .action(async (id: string | undefined, opts: PluginUpdateOptions) => {
      const { runPluginUpdateCommand } = await import("./plugins-update-command.js");
      await runPluginUpdateCommand({
        id,
        opts: {
          ...opts,
          acknowledgeClawHubRisk: normalizeCommanderClawHubRiskOption(opts),
        },
      });
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
      const shadowed = report.diagnostics.filter((entry) =>
        isErroredConfigSelectedShadowDiagnostic({ entry, plugins: report.plugins }),
      );
      const compatibility = buildPluginCompatibilityNotices({ report });

      if (
        errors.length === 0 &&
        diags.length === 0 &&
        shadowed.length === 0 &&
        compatibility.length === 0
      ) {
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
