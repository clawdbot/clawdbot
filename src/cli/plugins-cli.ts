import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { loadConfig, writeConfigFile } from "../config/config.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveArchiveKind } from "../infra/archive.js";
import {
  installPluginFromNpmSpec,
  installPluginFromPath,
  resolvePluginInstallDir,
} from "../plugins/install.js";
import { recordPluginInstall } from "../plugins/installs.js";
import type { PluginRecord } from "../plugins/registry.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath } from "../utils.js";

export type PluginsListOptions = {
  json?: boolean;
  enabled?: boolean;
  verbose?: boolean;
};

export type PluginInfoOptions = {
  json?: boolean;
};

export type PluginUpdateOptions = {
  all?: boolean;
  dryRun?: boolean;
};

function formatPluginLine(plugin: PluginRecord, verbose = false): string {
  const status =
    plugin.status === "loaded"
      ? chalk.green("✓")
      : plugin.status === "disabled"
        ? chalk.yellow("disabled")
        : chalk.red("error");
  const name = plugin.name ? chalk.white(plugin.name) : chalk.white(plugin.id);
  const idSuffix = plugin.name !== plugin.id ? chalk.gray(` (${plugin.id})`) : "";
  const desc = plugin.description
    ? chalk.gray(
        plugin.description.length > 60
          ? `${plugin.description.slice(0, 57)}...`
          : plugin.description,
      )
    : chalk.gray("(no description)");

  if (!verbose) {
    return `${name}${idSuffix} ${status} - ${desc}`;
  }

  const parts = [
    `${name}${idSuffix} ${status}`,
    `  source: ${chalk.gray(plugin.source)}`,
    `  origin: ${plugin.origin}`,
  ];
  if (plugin.version) parts.push(`  version: ${plugin.version}`);
  if (plugin.providerIds.length > 0) {
    parts.push(`  providers: ${plugin.providerIds.join(", ")}`);
  }
  if (plugin.error) parts.push(chalk.red(`  error: ${plugin.error}`));
  return parts.join("\n");
}

async function readInstalledPackageVersion(dir: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path.join(dir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function registerPluginsCli(program: Command) {
  const plugins = program
    .command("plugins")
    .description("Manage Clawdbot plugins/extensions")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/plugins", "docs.clawd.bot/cli/plugins")}\n`,
    );

  plugins
    .command("list")
    .description("List discovered plugins")
    .option("--json", "Print JSON")
    .option("--enabled", "Only show enabled plugins", false)
    .option("--verbose", "Show detailed entries", false)
    .action((opts: PluginsListOptions) => {
      const report = buildPluginStatusReport();
      const list = opts.enabled
        ? report.plugins.filter((p) => p.status === "loaded")
        : report.plugins;

      if (opts.json) {
        const payload = {
          workspaceDir: report.workspaceDir,
          plugins: list,
          diagnostics: report.diagnostics,
        };
        defaultRuntime.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (list.length === 0) {
        defaultRuntime.log("No plugins found.");
        return;
      }

      const lines: string[] = [];
      const loaded = list.filter((p) => p.status === "loaded").length;
      lines.push(
        `${chalk.bold.cyan("Plugins")} ${chalk.gray(`(${loaded}/${list.length} loaded)`)}`,
      );
      lines.push("");
      for (const plugin of list) {
        lines.push(formatPluginLine(plugin, opts.verbose));
        if (opts.verbose) lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    });

  plugins
    .command("info")
    .description("Show plugin details")
    .argument("<id>", "Plugin id")
    .option("--json", "Print JSON")
    .action((id: string, opts: PluginInfoOptions) => {
      const report = buildPluginStatusReport();
      const plugin = report.plugins.find((p) => p.id === id || p.name === id);
      if (!plugin) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        process.exit(1);
      }
      const cfg = loadConfig();
      const install = cfg.plugins?.installs?.[plugin.id];

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(plugin, null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push(chalk.bold.cyan(plugin.name || plugin.id));
      if (plugin.name && plugin.name !== plugin.id) {
        lines.push(chalk.gray(`id: ${plugin.id}`));
      }
      if (plugin.description) lines.push(plugin.description);
      lines.push("");
      lines.push(`Status: ${plugin.status}`);
      lines.push(`Source: ${plugin.source}`);
      lines.push(`Origin: ${plugin.origin}`);
      if (plugin.version) lines.push(`Version: ${plugin.version}`);
      if (plugin.toolNames.length > 0) {
        lines.push(`Tools: ${plugin.toolNames.join(", ")}`);
      }
      if (plugin.hookNames.length > 0) {
        lines.push(`Hooks: ${plugin.hookNames.join(", ")}`);
      }
      if (plugin.gatewayMethods.length > 0) {
        lines.push(`Gateway methods: ${plugin.gatewayMethods.join(", ")}`);
      }
      if (plugin.providerIds.length > 0) {
        lines.push(`Providers: ${plugin.providerIds.join(", ")}`);
      }
      if (plugin.cliCommands.length > 0) {
        lines.push(`CLI commands: ${plugin.cliCommands.join(", ")}`);
      }
      if (plugin.services.length > 0) {
        lines.push(`Services: ${plugin.services.join(", ")}`);
      }
      if (plugin.error) lines.push(chalk.red(`Error: ${plugin.error}`));
      if (install) {
        lines.push("");
        lines.push(`Install: ${install.source}`);
        if (install.spec) lines.push(`Spec: ${install.spec}`);
        if (install.sourcePath) lines.push(`Source path: ${install.sourcePath}`);
        if (install.installPath) lines.push(`Install path: ${install.installPath}`);
        if (install.version) lines.push(`Recorded version: ${install.version}`);
        if (install.installedAt) lines.push(`Installed at: ${install.installedAt}`);
      }
      defaultRuntime.log(lines.join("\n"));
    });

  plugins
    .command("enable")
    .description("Enable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const next = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [id]: {
              ...(cfg.plugins?.entries as Record<string, { enabled?: boolean }> | undefined)?.[id],
              enabled: true,
            },
          },
        },
      };
      await writeConfigFile(next);
      defaultRuntime.log(`Enabled plugin "${id}". Restart the gateway to apply.`);
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const next = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [id]: {
              ...(cfg.plugins?.entries as Record<string, { enabled?: boolean }> | undefined)?.[id],
              enabled: false,
            },
          },
        },
      };
      await writeConfigFile(next);
      defaultRuntime.log(`Disabled plugin "${id}". Restart the gateway to apply.`);
    });

  plugins
    .command("install")
    .description("Install a plugin (path, archive, or npm spec)")
    .argument("<path-or-spec>", "Path (.ts/.js/.zip/.tgz/.tar.gz) or an npm package spec")
    .option("-l, --link", "Link a local path instead of copying", false)
    .action(async (raw: string, opts: { link?: boolean }) => {
      const resolved = resolveUserPath(raw);
      const cfg = loadConfig();

      if (fs.existsSync(resolved)) {
        if (opts.link) {
          const existing = cfg.plugins?.load?.paths ?? [];
          const merged = Array.from(new Set([...existing, resolved]));
          const probe = await installPluginFromPath({ path: resolved, dryRun: true });
          if (!probe.ok) {
            defaultRuntime.error(probe.error);
            process.exit(1);
          }

          let next: ClawdbotConfig = {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              load: {
                ...cfg.plugins?.load,
                paths: merged,
              },
              entries: {
                ...cfg.plugins?.entries,
                [probe.pluginId]: {
                  ...(cfg.plugins?.entries?.[probe.pluginId] as object | undefined),
                  enabled: true,
                },
              },
            },
          };
          next = recordPluginInstall(next, {
            pluginId: probe.pluginId,
            source: "path",
            sourcePath: resolved,
            installPath: resolved,
            version: probe.version,
          });
          await writeConfigFile(next);
          defaultRuntime.log(`Linked plugin path: ${resolved}`);
          defaultRuntime.log(`Restart the gateway to load plugins.`);
          return;
        }

        const result = await installPluginFromPath({
          path: resolved,
          logger: {
            info: (msg) => defaultRuntime.log(msg),
            warn: (msg) => defaultRuntime.log(chalk.yellow(msg)),
          },
        });
        if (!result.ok) {
          defaultRuntime.error(result.error);
          process.exit(1);
        }

        let next: ClawdbotConfig = {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...cfg.plugins?.entries,
              [result.pluginId]: {
                ...(cfg.plugins?.entries?.[result.pluginId] as object | undefined),
                enabled: true,
              },
            },
          },
        };
        const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
        next = recordPluginInstall(next, {
          pluginId: result.pluginId,
          source,
          sourcePath: resolved,
          installPath: result.targetDir,
          version: result.version,
        });
        await writeConfigFile(next);
        defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
        defaultRuntime.log(`Restart the gateway to load plugins.`);
        return;
      }

      if (opts.link) {
        defaultRuntime.error("`--link` requires a local path.");
        process.exit(1);
      }

      const looksLikePath =
        raw.startsWith(".") ||
        raw.startsWith("~") ||
        path.isAbsolute(raw) ||
        raw.endsWith(".ts") ||
        raw.endsWith(".js") ||
        raw.endsWith(".mjs") ||
        raw.endsWith(".cjs") ||
        raw.endsWith(".tgz") ||
        raw.endsWith(".tar.gz") ||
        raw.endsWith(".tar") ||
        raw.endsWith(".zip");
      if (looksLikePath) {
        defaultRuntime.error(`Path not found: ${resolved}`);
        process.exit(1);
      }

      const result = await installPluginFromNpmSpec({
        spec: raw,
        logger: {
          info: (msg) => defaultRuntime.log(msg),
          warn: (msg) => defaultRuntime.log(chalk.yellow(msg)),
        },
      });
      if (!result.ok) {
        defaultRuntime.error(result.error);
        process.exit(1);
      }

      let next: ClawdbotConfig = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [result.pluginId]: {
              ...(cfg.plugins?.entries?.[result.pluginId] as object | undefined),
              enabled: true,
            },
          },
        },
      };
      next = recordPluginInstall(next, {
        pluginId: result.pluginId,
        source: "npm",
        spec: raw,
        installPath: result.targetDir,
        version: result.version,
      });
      await writeConfigFile(next);
      defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
      defaultRuntime.log(`Restart the gateway to load plugins.`);
    });

  plugins
    .command("update")
    .description("Update installed plugins (npm installs only)")
    .argument("[id]", "Plugin id (omit with --all)")
    .option("--all", "Update all tracked plugins", false)
    .option("--dry-run", "Show what would change without writing", false)
    .action(async (id: string | undefined, opts: PluginUpdateOptions) => {
      const cfg = loadConfig();
      const installs = cfg.plugins?.installs ?? {};
      const targets = opts.all ? Object.keys(installs) : id ? [id] : [];

      if (targets.length === 0) {
        defaultRuntime.error("Provide a plugin id or use --all.");
        process.exit(1);
      }

      let nextCfg = cfg;
      let updatedCount = 0;

      for (const pluginId of targets) {
        const record = installs[pluginId];
        if (!record) {
          defaultRuntime.log(chalk.yellow(`No install record for "${pluginId}".`));
          continue;
        }
        if (record.source !== "npm") {
          defaultRuntime.log(chalk.yellow(`Skipping "${pluginId}" (source: ${record.source}).`));
          continue;
        }
        if (!record.spec) {
          defaultRuntime.log(chalk.yellow(`Skipping "${pluginId}" (missing npm spec).`));
          continue;
        }

        const installPath = record.installPath ?? resolvePluginInstallDir(pluginId);
        const currentVersion = await readInstalledPackageVersion(installPath);

        if (opts.dryRun) {
          const probe = await installPluginFromNpmSpec({
            spec: record.spec,
            mode: "update",
            dryRun: true,
            expectedPluginId: pluginId,
            logger: {
              info: (msg) => defaultRuntime.log(msg),
              warn: (msg) => defaultRuntime.log(chalk.yellow(msg)),
            },
          });
          if (!probe.ok) {
            defaultRuntime.log(chalk.red(`Failed to check ${pluginId}: ${probe.error}`));
            continue;
          }

          const nextVersion = probe.version ?? "unknown";
          const currentLabel = currentVersion ?? "unknown";
          if (currentVersion && probe.version && currentVersion === probe.version) {
            defaultRuntime.log(`${pluginId} is up to date (${currentLabel}).`);
          } else {
            defaultRuntime.log(`Would update ${pluginId}: ${currentLabel} → ${nextVersion}.`);
          }
          continue;
        }

        const result = await installPluginFromNpmSpec({
          spec: record.spec,
          mode: "update",
          expectedPluginId: pluginId,
          logger: {
            info: (msg) => defaultRuntime.log(msg),
            warn: (msg) => defaultRuntime.log(chalk.yellow(msg)),
          },
        });
        if (!result.ok) {
          defaultRuntime.log(chalk.red(`Failed to update ${pluginId}: ${result.error}`));
          continue;
        }

        const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
        nextCfg = recordPluginInstall(nextCfg, {
          pluginId,
          source: "npm",
          spec: record.spec,
          installPath: result.targetDir,
          version: nextVersion,
        });
        updatedCount += 1;

        const currentLabel = currentVersion ?? "unknown";
        const nextLabel = nextVersion ?? "unknown";
        if (currentVersion && nextVersion && currentVersion === nextVersion) {
          defaultRuntime.log(`${pluginId} already at ${currentLabel}.`);
        } else {
          defaultRuntime.log(`Updated ${pluginId}: ${currentLabel} → ${nextLabel}.`);
        }
      }

      if (updatedCount > 0) {
        await writeConfigFile(nextCfg);
        defaultRuntime.log("Restart the gateway to load plugins.");
      }
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(() => {
      const report = buildPluginStatusReport();
      const errors = report.plugins.filter((p) => p.status === "error");
      const diags = report.diagnostics.filter((d) => d.level === "error");

      if (errors.length === 0 && diags.length === 0) {
        defaultRuntime.log("No plugin issues detected.");
        return;
      }

      const lines: string[] = [];
      if (errors.length > 0) {
        lines.push(chalk.bold.red("Plugin errors:"));
        for (const entry of errors) {
          lines.push(`- ${entry.id}: ${entry.error ?? "failed to load"} (${entry.source})`);
        }
      }
      if (diags.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(chalk.bold.yellow("Diagnostics:"));
        for (const diag of diags) {
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          lines.push(`- ${target}${diag.message}`);
        }
      }
      const docs = formatDocsLink("/plugin", "docs.clawd.bot/plugin");
      lines.push("");
      lines.push(`${theme.muted("Docs:")} ${docs}`);
      defaultRuntime.log(lines.join("\n"));
    });
}
