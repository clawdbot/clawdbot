import type { Command } from "commander";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
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

export type PluginAuthoringBuildOptions = {
  root?: string;
  entry?: string;
  check?: boolean;
};

export type PluginAuthoringValidateOptions = {
  root?: string;
  entry?: string;
};

export type PluginAuthoringInitOptions = {
  directory?: string;
  force?: boolean;
  name?: string;
};

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
      const { runPluginsEnableCommand } = await import("./plugins-cli.runtime.js");
      await runPluginsEnableCommand(id);
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const { runPluginsDisableCommand } = await import("./plugins-cli.runtime.js");
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
        const { runPluginsInstallAction } = await import("./plugins-cli.runtime.js");
        await runPluginsInstallAction(raw, opts);
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
      const { runPluginsRegistryCommand } = await import("./plugins-cli.runtime.js");
      await runPluginsRegistryCommand(opts);
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(async () => {
      const { runPluginsDoctorCommand } = await import("./plugins-cli.runtime.js");
      await runPluginsDoctorCommand();
    });

  plugins
    .command("build")
    .description("Generate simple tool plugin metadata")
    .option("--root <path>", "Plugin package root")
    .option("--entry <path>", "Plugin entry module relative to --root")
    .option("--check", "Fail if generated metadata is out of date", false)
    .action(async (opts: PluginAuthoringBuildOptions) => {
      const { runPluginsBuildCommand } = await import("./plugins-authoring-command.js");
      await runPluginsBuildCommand(opts);
    });

  plugins
    .command("validate")
    .description("Validate simple tool plugin metadata")
    .option("--root <path>", "Plugin package root")
    .option("--entry <path>", "Plugin entry module relative to --root")
    .action(async (opts: PluginAuthoringValidateOptions) => {
      const { runPluginsValidateCommand } = await import("./plugins-authoring-command.js");
      await runPluginsValidateCommand(opts);
    });

  plugins
    .command("init")
    .description("Create a simple tool plugin project")
    .argument("<id>", "Plugin id")
    .option("--directory <path>", "Output directory")
    .option("--name <name>", "Display name")
    .option("--force", "Overwrite an existing output directory", false)
    .action(async (id: string, opts: PluginAuthoringInitOptions) => {
      const { runPluginsInitCommand } = await import("./plugins-authoring-command.js");
      await runPluginsInitCommand(id, opts);
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
      const { runPluginMarketplaceListCommand } = await import("./plugins-cli.runtime.js");
      await runPluginMarketplaceListCommand(source, opts);
    });

  applyParentDefaultHelpAction(plugins);
}
