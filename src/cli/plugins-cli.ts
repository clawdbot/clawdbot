// Commander registration for plugin list/search/inspect/install/update/authoring commands.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { PluginInspectOptions } from "./plugins-inspect-command.js";
import type { PluginsListOptions } from "./plugins-list-command.js";
import { parseStrictPositiveIntOption } from "./program/helpers.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type PluginUpdateOptions = {
  all?: boolean;
  acknowledgeClawhubRisk?: boolean;
  dryRun?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
};

type CommanderClawHubRiskOptions = Record<string, unknown> & {
  acknowledgeClawHubRisk?: boolean;
  acknowledgeClawhubRisk?: boolean;
};

function normalizeCommanderClawHubRiskOption(opts: CommanderClawHubRiskOptions): boolean {
  return opts.acknowledgeClawhubRisk === true || opts.acknowledgeClawHubRisk === true;
}

export type PluginMarketplaceListOptions = {
  json?: boolean;
};

export type PluginMarketplaceEntriesOptions = {
  feedProfile?: string;
  feedUrl?: string;
  json?: boolean;
  offline?: boolean;
};

export type PluginMarketplaceRefreshOptions = {
  expectedSha256?: string;
  feedProfile?: string;
  feedUrl?: string;
  json?: boolean;
};

type PluginSearchOptions = {
  json?: boolean;
  limit?: number;
};

type PluginUninstallOptions = {
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

type PluginAuthoringBuildOptions = {
  root?: string;
  entry?: string;
  check?: boolean;
};

type PluginAuthoringValidateOptions = {
  root?: string;
  entry?: string;
};

type PluginAuthoringInitOptions = {
  directory?: string;
  force?: boolean;
  type?: string;
};

function createModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  // Plugin runtime modules are heavy; load each command surface once on first use.
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

const loadPluginsRuntime = createModuleLoader(() => import("./plugins-cli.runtime.js"));
const loadPluginsAuthoringCommands = createModuleLoader(
  () => import("./plugins-authoring-command.js"),
);

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
    .option("--limit <n>", "Max results", (value) => parseStrictPositiveIntOption(value, "--limit"))
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
      const { runPluginsEnableCommand } = await loadPluginsRuntime();
      await runPluginsEnableCommand(id);
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const { runPluginsDisableCommand } = await loadPluginsRuntime();
      await runPluginsDisableCommand(id);
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
      await runPluginUninstallCommand(id, { ...opts, invalidateRuntimeCache: false });
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
    .option(
      "--force",
      "Confirm non-ClawHub sources and overwrite an existing plugin or hook pack",
      false,
    )
    .option("--pin", "Record npm installs as exact resolved <name>@<version>", false)
    .option(
      "--dangerously-force-unsafe-install",
      "Deprecated no-op; security.installPolicy may still block",
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
        const { runPluginsInstallAction } = await loadPluginsRuntime();
        await runPluginsInstallAction(raw, {
          ...opts,
          acknowledgeClawHubRisk: normalizeCommanderClawHubRiskOption(opts),
        });
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
      "Deprecated no-op; security.installPolicy may still block",
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
      const { runPluginsRegistryCommand } = await loadPluginsRuntime();
      await runPluginsRegistryCommand(opts);
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(async () => {
      const { runPluginsDoctorCommand } = await loadPluginsRuntime();
      await runPluginsDoctorCommand();
    });

  plugins
    .command("build")
    .description("Generate simple tool plugin metadata")
    .option("--root <path>", "Plugin package root")
    .option("--entry <path>", "Plugin entry module relative to --root")
    .option("--check", "Fail if generated metadata is out of date", false)
    .action(async (opts: PluginAuthoringBuildOptions) => {
      const { runPluginsBuildCommand } = await loadPluginsAuthoringCommands();
      await runPluginsBuildCommand(opts);
    });

  plugins
    .command("validate")
    .description("Validate simple tool plugin metadata")
    .option("--root <path>", "Plugin package root")
    .option("--entry <path>", "Plugin entry module relative to --root")
    .action(async (opts: PluginAuthoringValidateOptions) => {
      const { runPluginsValidateCommand } = await loadPluginsAuthoringCommands();
      await runPluginsValidateCommand(opts);
    });

  plugins
    .command("init")
    .description("Create a plugin project")
    .argument("<id>", "Plugin id")
    .option("--directory <path>", "Output directory")
    .option("--name <name>", "Display name")
    .option("--type <type>", "Scaffold type (tool or provider)", "tool")
    .option("--force", "Overwrite an existing output directory", false)
    .action(async (id: string, opts: PluginAuthoringInitOptions) => {
      const { runPluginsInitCommand } = await loadPluginsAuthoringCommands();
      await runPluginsInitCommand(id, opts);
    });

  const marketplace = plugins
    .command("marketplace")
    .description("Inspect Claude-compatible plugin marketplaces");

  marketplace
    .command("entries")
    .description("List entries from the configured OpenClaw marketplace feed")
    .option("--feed-profile <name>", "Configured marketplace feed profile to list")
    .option("--feed-url <url>", "Explicit hosted marketplace feed URL")
    .option("--offline", "Read the latest accepted snapshot without fetching the feed", false)
    .option("--json", "Print JSON")
    .action(async (opts: PluginMarketplaceEntriesOptions) => {
      const { runPluginMarketplaceEntriesCommand } = await loadPluginsRuntime();
      await runPluginMarketplaceEntriesCommand(opts);
    });

  marketplace
    .command("refresh")
    .description("Refresh the configured OpenClaw marketplace feed snapshot")
    .option("--feed-profile <name>", "Configured marketplace feed profile to refresh")
    .option("--feed-url <url>", "Explicit hosted marketplace feed URL")
    .option("--expected-sha256 <hash>", "Expected hosted feed SHA-256 payload checksum")
    .option("--json", "Print JSON")
    .action(async (opts: PluginMarketplaceRefreshOptions) => {
      const { runPluginMarketplaceRefreshCommand } = await loadPluginsRuntime();
      await runPluginMarketplaceRefreshCommand(opts);
    });

  marketplace
    .command("list")
    .description("List plugins published by a marketplace source")
    .argument("<source>", "Local marketplace path/repo or git/GitHub source")
    .option("--json", "Print JSON")
    .action(async (source: string, opts: PluginMarketplaceListOptions) => {
      const { runPluginMarketplaceListCommand } = await loadPluginsRuntime();
      await runPluginMarketplaceListCommand(source, opts);
    });

  applyParentDefaultHelpAction(plugins);
}
