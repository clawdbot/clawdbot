import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveArchiveKind } from "../infra/archive.js";
import {
  buildWorkspaceHookStatus,
  type HookStatusEntry,
  type HookStatusReport,
} from "../hooks/hooks-status.js";
import type { HookEntry } from "../hooks/types.js";
import { loadWorkspaceHookEntries } from "../hooks/workspace.js";
import { loadConfig, writeConfigFile } from "../config/io.js";
import {
  installHooksFromNpmSpec,
  installHooksFromPath,
  resolveHookInstallDir,
} from "../hooks/install.js";
import { recordHookInstall } from "../hooks/installs.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath } from "../utils.js";

export type HooksListOptions = {
  json?: boolean;
  eligible?: boolean;
  verbose?: boolean;
};

export type HookInfoOptions = {
  json?: boolean;
};

export type HooksCheckOptions = {
  json?: boolean;
};

export type HooksUpdateOptions = {
  all?: boolean;
  dryRun?: boolean;
};

function mergeHookEntries(pluginEntries: HookEntry[], workspaceEntries: HookEntry[]): HookEntry[] {
  const merged = new Map<string, HookEntry>();
  for (const entry of pluginEntries) {
    merged.set(entry.hook.name, entry);
  }
  for (const entry of workspaceEntries) {
    merged.set(entry.hook.name, entry);
  }
  return Array.from(merged.values());
}

function buildHooksReport(config: ClawdbotConfig): HookStatusReport {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config });
  const pluginReport = buildPluginStatusReport({ config, workspaceDir });
  const pluginEntries = pluginReport.hooks.map((hook) => hook.entry);
  const entries = mergeHookEntries(pluginEntries, workspaceEntries);
  return buildWorkspaceHookStatus(workspaceDir, { config, entries });
}

/**
 * Format a single hook for display in the list
 */
function formatHookLine(hook: HookStatusEntry, verbose = false): string {
  const emoji = hook.emoji ?? "🔗";
  const status = hook.eligible
    ? chalk.green("✓")
    : hook.disabled
      ? chalk.yellow("disabled")
      : chalk.red("missing reqs");

  const name = hook.eligible ? chalk.white(hook.name) : chalk.gray(hook.name);

  const desc = chalk.gray(
    hook.description.length > 50 ? `${hook.description.slice(0, 47)}...` : hook.description,
  );
  const sourceLabel = hook.managedByPlugin
    ? chalk.magenta(`plugin:${hook.pluginId ?? "unknown"}`)
    : "";

  if (verbose) {
    const missing: string[] = [];
    if (hook.missing.bins.length > 0) {
      missing.push(`bins: ${hook.missing.bins.join(", ")}`);
    }
    if (hook.missing.anyBins.length > 0) {
      missing.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
    }
    if (hook.missing.env.length > 0) {
      missing.push(`env: ${hook.missing.env.join(", ")}`);
    }
    if (hook.missing.config.length > 0) {
      missing.push(`config: ${hook.missing.config.join(", ")}`);
    }
    if (hook.missing.os.length > 0) {
      missing.push(`os: ${hook.missing.os.join(", ")}`);
    }
    const missingStr = missing.length > 0 ? chalk.red(` [${missing.join("; ")}]`) : "";
    const sourceSuffix = sourceLabel ? ` ${sourceLabel}` : "";
    return `${emoji} ${name} ${status}${missingStr}\n   ${desc}${sourceSuffix}`;
  }

  const sourceSuffix = sourceLabel ? ` ${sourceLabel}` : "";
  return `${emoji} ${name} ${status} - ${desc}${sourceSuffix}`;
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

/**
 * Format the hooks list output
 */
export function formatHooksList(report: HookStatusReport, opts: HooksListOptions): string {
  const hooks = opts.eligible ? report.hooks.filter((h) => h.eligible) : report.hooks;

  if (opts.json) {
    const jsonReport = {
      workspaceDir: report.workspaceDir,
      managedHooksDir: report.managedHooksDir,
      hooks: hooks.map((h) => ({
        name: h.name,
        description: h.description,
        emoji: h.emoji,
        eligible: h.eligible,
        disabled: h.disabled,
        source: h.source,
        pluginId: h.pluginId,
        events: h.events,
        homepage: h.homepage,
        missing: h.missing,
        managedByPlugin: h.managedByPlugin,
      })),
    };
    return JSON.stringify(jsonReport, null, 2);
  }

  if (hooks.length === 0) {
    const message = opts.eligible
      ? "No eligible hooks found. Run `clawdbot hooks list` to see all hooks."
      : "No hooks found.";
    return message;
  }

  const eligible = hooks.filter((h) => h.eligible);
  const notEligible = hooks.filter((h) => !h.eligible);

  const lines: string[] = [];
  lines.push(chalk.bold.cyan("Hooks") + chalk.gray(` (${eligible.length}/${hooks.length} ready)`));
  lines.push("");

  if (eligible.length > 0) {
    lines.push(chalk.bold.green("Ready:"));
    for (const hook of eligible) {
      lines.push(`  ${formatHookLine(hook, opts.verbose)}`);
    }
  }

  if (notEligible.length > 0 && !opts.eligible) {
    if (eligible.length > 0) lines.push("");
    lines.push(chalk.bold.yellow("Not ready:"));
    for (const hook of notEligible) {
      lines.push(`  ${formatHookLine(hook, opts.verbose)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format detailed info for a single hook
 */
export function formatHookInfo(
  report: HookStatusReport,
  hookName: string,
  opts: HookInfoOptions,
): string {
  const hook = report.hooks.find((h) => h.name === hookName || h.hookKey === hookName);

  if (!hook) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", hook: hookName }, null, 2);
    }
    return `Hook "${hookName}" not found. Run \`clawdbot hooks list\` to see available hooks.`;
  }

  if (opts.json) {
    return JSON.stringify(hook, null, 2);
  }

  const lines: string[] = [];
  const emoji = hook.emoji ?? "🔗";
  const status = hook.eligible
    ? chalk.green("✓ Ready")
    : hook.disabled
      ? chalk.yellow("⏸ Disabled")
      : chalk.red("✗ Missing requirements");

  lines.push(`${emoji} ${chalk.bold.cyan(hook.name)} ${status}`);
  lines.push("");
  lines.push(chalk.white(hook.description));
  lines.push("");

  // Details
  lines.push(chalk.bold("Details:"));
  if (hook.managedByPlugin) {
    lines.push(`  Source: ${hook.source} (${hook.pluginId ?? "unknown"})`);
  } else {
    lines.push(`  Source: ${hook.source}`);
  }
  lines.push(`  Path: ${chalk.gray(hook.filePath)}`);
  lines.push(`  Handler: ${chalk.gray(hook.handlerPath)}`);
  if (hook.homepage) {
    lines.push(`  Homepage: ${chalk.blue(hook.homepage)}`);
  }
  if (hook.events.length > 0) {
    lines.push(`  Events: ${hook.events.join(", ")}`);
  }
  if (hook.managedByPlugin) {
    lines.push(`  Managed by plugin; enable/disable via hooks CLI not available.`);
  }

  // Requirements
  const hasRequirements =
    hook.requirements.bins.length > 0 ||
    hook.requirements.anyBins.length > 0 ||
    hook.requirements.env.length > 0 ||
    hook.requirements.config.length > 0 ||
    hook.requirements.os.length > 0;

  if (hasRequirements) {
    lines.push("");
    lines.push(chalk.bold("Requirements:"));
    if (hook.requirements.bins.length > 0) {
      const binsStatus = hook.requirements.bins.map((bin) => {
        const missing = hook.missing.bins.includes(bin);
        return missing ? chalk.red(`✗ ${bin}`) : chalk.green(`✓ ${bin}`);
      });
      lines.push(`  Binaries: ${binsStatus.join(", ")}`);
    }
    if (hook.requirements.anyBins.length > 0) {
      const anyBinsStatus =
        hook.missing.anyBins.length > 0
          ? chalk.red(`✗ (any of: ${hook.requirements.anyBins.join(", ")})`)
          : chalk.green(`✓ (any of: ${hook.requirements.anyBins.join(", ")})`);
      lines.push(`  Any binary: ${anyBinsStatus}`);
    }
    if (hook.requirements.env.length > 0) {
      const envStatus = hook.requirements.env.map((env) => {
        const missing = hook.missing.env.includes(env);
        return missing ? chalk.red(`✗ ${env}`) : chalk.green(`✓ ${env}`);
      });
      lines.push(`  Environment: ${envStatus.join(", ")}`);
    }
    if (hook.requirements.config.length > 0) {
      const configStatus = hook.configChecks.map((check) => {
        return check.satisfied ? chalk.green(`✓ ${check.path}`) : chalk.red(`✗ ${check.path}`);
      });
      lines.push(`  Config: ${configStatus.join(", ")}`);
    }
    if (hook.requirements.os.length > 0) {
      const osStatus =
        hook.missing.os.length > 0
          ? chalk.red(`✗ (${hook.requirements.os.join(", ")})`)
          : chalk.green(`✓ (${hook.requirements.os.join(", ")})`);
      lines.push(`  OS: ${osStatus}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format check output
 */
export function formatHooksCheck(report: HookStatusReport, opts: HooksCheckOptions): string {
  if (opts.json) {
    const eligible = report.hooks.filter((h) => h.eligible);
    const notEligible = report.hooks.filter((h) => !h.eligible);
    return JSON.stringify(
      {
        total: report.hooks.length,
        eligible: eligible.length,
        notEligible: notEligible.length,
        hooks: {
          eligible: eligible.map((h) => h.name),
          notEligible: notEligible.map((h) => ({
            name: h.name,
            missing: h.missing,
          })),
        },
      },
      null,
      2,
    );
  }

  const eligible = report.hooks.filter((h) => h.eligible);
  const notEligible = report.hooks.filter((h) => !h.eligible);

  const lines: string[] = [];
  lines.push(chalk.bold.cyan("Hooks Status"));
  lines.push("");
  lines.push(`Total hooks: ${report.hooks.length}`);
  lines.push(chalk.green(`Ready: ${eligible.length}`));
  lines.push(chalk.yellow(`Not ready: ${notEligible.length}`));

  if (notEligible.length > 0) {
    lines.push("");
    lines.push(chalk.bold.yellow("Hooks not ready:"));
    for (const hook of notEligible) {
      const reasons = [];
      if (hook.disabled) reasons.push("disabled");
      if (hook.missing.bins.length > 0) reasons.push(`bins: ${hook.missing.bins.join(", ")}`);
      if (hook.missing.anyBins.length > 0)
        reasons.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
      if (hook.missing.env.length > 0) reasons.push(`env: ${hook.missing.env.join(", ")}`);
      if (hook.missing.config.length > 0) reasons.push(`config: ${hook.missing.config.join(", ")}`);
      if (hook.missing.os.length > 0) reasons.push(`os: ${hook.missing.os.join(", ")}`);
      lines.push(`  ${hook.emoji ?? "🔗"} ${hook.name} - ${reasons.join("; ")}`);
    }
  }

  return lines.join("\n");
}

export async function enableHook(hookName: string): Promise<void> {
  const config = loadConfig();
  const report = buildHooksReport(config);
  const hook = report.hooks.find((h) => h.name === hookName);

  if (!hook) {
    throw new Error(`Hook "${hookName}" not found`);
  }

  if (hook.managedByPlugin) {
    throw new Error(
      `Hook "${hookName}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`,
    );
  }

  if (!hook.eligible) {
    throw new Error(`Hook "${hookName}" is not eligible (missing requirements)`);
  }

  // Update config
  const entries = { ...config.hooks?.internal?.entries };
  entries[hookName] = { ...entries[hookName], enabled: true };

  const nextConfig = {
    ...config,
    hooks: {
      ...config.hooks,
      internal: {
        ...config.hooks?.internal,
        enabled: true,
        entries,
      },
    },
  };

  await writeConfigFile(nextConfig);
  console.log(`${chalk.green("✓")} Enabled hook: ${hook.emoji ?? "🔗"} ${hookName}`);
}

export async function disableHook(hookName: string): Promise<void> {
  const config = loadConfig();
  const report = buildHooksReport(config);
  const hook = report.hooks.find((h) => h.name === hookName);

  if (!hook) {
    throw new Error(`Hook "${hookName}" not found`);
  }

  if (hook.managedByPlugin) {
    throw new Error(
      `Hook "${hookName}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`,
    );
  }

  // Update config
  const entries = { ...config.hooks?.internal?.entries };
  entries[hookName] = { ...entries[hookName], enabled: false };

  const nextConfig = {
    ...config,
    hooks: {
      ...config.hooks,
      internal: {
        ...config.hooks?.internal,
        entries,
      },
    },
  };

  await writeConfigFile(nextConfig);
  console.log(`${chalk.yellow("⏸")} Disabled hook: ${hook.emoji ?? "🔗"} ${hookName}`);
}

export function registerHooksCli(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Manage internal agent hooks")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/hooks", "docs.clawd.bot/cli/hooks")}\n`,
    );

  hooks
    .command("list")
    .description("List all hooks")
    .option("--eligible", "Show only eligible hooks", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const report = buildHooksReport(config);
        console.log(formatHooksList(report, opts));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  hooks
    .command("info <name>")
    .description("Show detailed information about a hook")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      try {
        const config = loadConfig();
        const report = buildHooksReport(config);
        console.log(formatHookInfo(report, name, opts));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  hooks
    .command("check")
    .description("Check hooks eligibility status")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const report = buildHooksReport(config);
        console.log(formatHooksCheck(report, opts));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  hooks
    .command("enable <name>")
    .description("Enable a hook")
    .action(async (name) => {
      try {
        await enableHook(name);
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  hooks
    .command("disable <name>")
    .description("Disable a hook")
    .action(async (name) => {
      try {
        await disableHook(name);
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  hooks
    .command("install")
    .description("Install a hook pack (path, archive, or npm spec)")
    .argument("<path-or-spec>", "Path to a hook pack or npm package spec")
    .option("-l, --link", "Link a local path instead of copying", false)
    .action(async (raw: string, opts: { link?: boolean }) => {
      const resolved = resolveUserPath(raw);
      const cfg = loadConfig();

      if (fs.existsSync(resolved)) {
        if (opts.link) {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) {
            defaultRuntime.error("Linked hook paths must be directories.");
            process.exit(1);
          }

          const existing = cfg.hooks?.internal?.load?.extraDirs ?? [];
          const merged = Array.from(new Set([...existing, resolved]));
          const probe = await installHooksFromPath({ path: resolved, dryRun: true });
          if (!probe.ok) {
            defaultRuntime.error(probe.error);
            process.exit(1);
          }

          let next: ClawdbotConfig = {
            ...cfg,
            hooks: {
              ...cfg.hooks,
              internal: {
                ...cfg.hooks?.internal,
                enabled: true,
                load: {
                  ...cfg.hooks?.internal?.load,
                  extraDirs: merged,
                },
              },
            },
          };

          for (const hookName of probe.hooks) {
            next = {
              ...next,
              hooks: {
                ...next.hooks,
                internal: {
                  ...next.hooks?.internal,
                  entries: {
                    ...next.hooks?.internal?.entries,
                    [hookName]: {
                      ...(next.hooks?.internal?.entries?.[hookName] as object | undefined),
                      enabled: true,
                    },
                  },
                },
              },
            };
          }

          next = recordHookInstall(next, {
            hookId: probe.hookPackId,
            source: "path",
            sourcePath: resolved,
            installPath: resolved,
            version: probe.version,
            hooks: probe.hooks,
          });

          await writeConfigFile(next);
          defaultRuntime.log(`Linked hook path: ${resolved}`);
          defaultRuntime.log(`Restart the gateway to load hooks.`);
          return;
        }

        const result = await installHooksFromPath({
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
          hooks: {
            ...cfg.hooks,
            internal: {
              ...cfg.hooks?.internal,
              enabled: true,
              entries: {
                ...cfg.hooks?.internal?.entries,
              },
            },
          },
        };

        for (const hookName of result.hooks) {
          next = {
            ...next,
            hooks: {
              ...next.hooks,
              internal: {
                ...next.hooks?.internal,
                entries: {
                  ...next.hooks?.internal?.entries,
                  [hookName]: {
                    ...(next.hooks?.internal?.entries?.[hookName] as object | undefined),
                    enabled: true,
                  },
                },
              },
            },
          };
        }

        const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";

        next = recordHookInstall(next, {
          hookId: result.hookPackId,
          source,
          sourcePath: resolved,
          installPath: result.targetDir,
          version: result.version,
          hooks: result.hooks,
        });

        await writeConfigFile(next);
        defaultRuntime.log(`Installed hooks: ${result.hooks.join(", ")}`);
        defaultRuntime.log(`Restart the gateway to load hooks.`);
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
        raw.endsWith(".zip") ||
        raw.endsWith(".tgz") ||
        raw.endsWith(".tar.gz") ||
        raw.endsWith(".tar");
      if (looksLikePath) {
        defaultRuntime.error(`Path not found: ${resolved}`);
        process.exit(1);
      }

      const result = await installHooksFromNpmSpec({
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
        hooks: {
          ...cfg.hooks,
          internal: {
            ...cfg.hooks?.internal,
            enabled: true,
            entries: {
              ...cfg.hooks?.internal?.entries,
            },
          },
        },
      };

      for (const hookName of result.hooks) {
        next = {
          ...next,
          hooks: {
            ...next.hooks,
            internal: {
              ...next.hooks?.internal,
              entries: {
                ...next.hooks?.internal?.entries,
                [hookName]: {
                  ...(next.hooks?.internal?.entries?.[hookName] as object | undefined),
                  enabled: true,
                },
              },
            },
          },
        };
      }

      next = recordHookInstall(next, {
        hookId: result.hookPackId,
        source: "npm",
        spec: raw,
        installPath: result.targetDir,
        version: result.version,
        hooks: result.hooks,
      });
      await writeConfigFile(next);
      defaultRuntime.log(`Installed hooks: ${result.hooks.join(", ")}`);
      defaultRuntime.log(`Restart the gateway to load hooks.`);
    });

  hooks
    .command("update")
    .description("Update installed hooks (npm installs only)")
    .argument("[id]", "Hook pack id (omit with --all)")
    .option("--all", "Update all tracked hooks", false)
    .option("--dry-run", "Show what would change without writing", false)
    .action(async (id: string | undefined, opts: HooksUpdateOptions) => {
      const cfg = loadConfig();
      const installs = cfg.hooks?.internal?.installs ?? {};
      const targets = opts.all ? Object.keys(installs) : id ? [id] : [];

      if (targets.length === 0) {
        defaultRuntime.error("Provide a hook id or use --all.");
        process.exit(1);
      }

      let nextCfg = cfg;
      let updatedCount = 0;

      for (const hookId of targets) {
        const record = installs[hookId];
        if (!record) {
          defaultRuntime.log(chalk.yellow(`No install record for "${hookId}".`));
          continue;
        }
        if (record.source !== "npm") {
          defaultRuntime.log(chalk.yellow(`Skipping "${hookId}" (source: ${record.source}).`));
          continue;
        }
        if (!record.spec) {
          defaultRuntime.log(chalk.yellow(`Skipping "${hookId}" (missing npm spec).`));
          continue;
        }

        const installPath = record.installPath ?? resolveHookInstallDir(hookId);
        const currentVersion = await readInstalledPackageVersion(installPath);

        if (opts.dryRun) {
          const probe = await installHooksFromNpmSpec({
            spec: record.spec,
            mode: "update",
            dryRun: true,
            expectedHookPackId: hookId,
            logger: {
              info: (msg) => defaultRuntime.log(msg),
              warn: (msg) => defaultRuntime.log(chalk.yellow(msg)),
            },
          });
          if (!probe.ok) {
            defaultRuntime.log(chalk.red(`Failed to check ${hookId}: ${probe.error}`));
            continue;
          }

          const nextVersion = probe.version ?? "unknown";
          const currentLabel = currentVersion ?? "unknown";
          if (currentVersion && probe.version && currentVersion === probe.version) {
            defaultRuntime.log(`${hookId} is up to date (${currentLabel}).`);
          } else {
            defaultRuntime.log(`Would update ${hookId}: ${currentLabel} → ${nextVersion}.`);
          }
          continue;
        }

        const result = await installHooksFromNpmSpec({
          spec: record.spec,
          mode: "update",
          expectedHookPackId: hookId,
          logger: {
            info: (msg) => defaultRuntime.log(msg),
            warn: (msg) => defaultRuntime.log(chalk.yellow(msg)),
          },
        });
        if (!result.ok) {
          defaultRuntime.log(chalk.red(`Failed to update ${hookId}: ${result.error}`));
          continue;
        }

        const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
        nextCfg = recordHookInstall(nextCfg, {
          hookId,
          source: "npm",
          spec: record.spec,
          installPath: result.targetDir,
          version: nextVersion,
          hooks: result.hooks,
        });
        updatedCount += 1;

        const currentLabel = currentVersion ?? "unknown";
        const nextLabel = nextVersion ?? "unknown";
        if (currentVersion && nextVersion && currentVersion === nextVersion) {
          defaultRuntime.log(`${hookId} already at ${currentLabel}.`);
        } else {
          defaultRuntime.log(`Updated ${hookId}: ${currentLabel} → ${nextLabel}.`);
        }
      }

      if (updatedCount > 0) {
        await writeConfigFile(nextCfg);
        defaultRuntime.log("Restart the gateway to load hooks.");
      }
    });

  hooks.action(async () => {
    try {
      const config = loadConfig();
      const report = buildHooksReport(config);
      console.log(formatHooksList(report, {}));
    } catch (err) {
      console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
}
