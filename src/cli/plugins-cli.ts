import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { getRuntimeConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import type { PluginInspectOptions } from "./plugins-inspect-command.js";
import type { PluginsListOptions } from "./plugins-list-command.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

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
      const { runPluginsListCommand } = await import("./plugins-list-command.js");
      await runPluginsListCommand(opts);
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
