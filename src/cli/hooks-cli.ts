import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { MoltbotConfig } from "../config/config.js";
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
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";

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

function buildHooksReport(config: MoltbotConfig): HookStatusReport {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config });
  const pluginReport = buildPluginStatusReport({ config, workspaceDir });
  const pluginEntries = pluginReport.hooks.map((hook) => hook.entry);
  const entries = mergeHookEntries(pluginEntries, workspaceEntries);
  return buildWorkspaceHookStatus(workspaceDir, { config, entries });
}

function formatHookStatus(hook: HookStatusEntry): string {
  if (hook.eligible) return theme.success("✓ ready");
  if (hook.disabled) return theme.warn("⏸ disabled");
  return theme.error("✗ missing");
}

function formatHookName(hook: HookStatusEntry): string {
  const emoji = hook.emoji ?? "🔗";
  return `${emoji} ${theme.command(hook.name)}`;
}

function formatHookSource(hook: HookStatusEntry): string {
  if (!hook.managedByPlugin) return hook.source;
  return `plugin:${hook.pluginId ?? "unknown"}`;
}

function formatHookMissingSummary(hook: HookStatusEntry): string {
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
  return missing.join("; ");
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
      ? `No eligible hooks found. Run \`${formatCliCommand("moltbot hooks list")}\` to see all hooks.`
      : "No hooks found.";
    return message;
  }

  const eligible = hooks.filter((h) => h.eligible);
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const rows = hooks.map((hook) => {
    const missing = formatHookMissingSummary(hook);
    return {
      Status: formatHookStatus(hook),
      Hook: formatHookName(hook),
      Description: theme.muted(hook.description),
      Source: formatHookSource(hook),
      Missing: missing ? theme.warn(missing) : "",
    };
  });

  const columns = [
    { key: "Status", header: "Status", minWidth: 10 },
    { key: "Hook", header: "Hook", minWidth: 18, flex: true },
    { key: "Description", header: "Description", minWidth: 24, flex: true },
    { key: "Source", header: "Source", minWidth: 12, flex: true },
  ];
  if (opts.verbose) {
    columns.push({ key: "Missing", header: "Missing", minWidth: 18, flex: true });
  }

  const lines: string[] = [];
  lines.push(
    `${theme.heading("Hooks")} ${theme.muted(`(${eligible.length}/${hooks.length} ready)`)}`,
  );
  lines.push(
    renderTable({
      width: tableWidth,
      columns,
      rows,
    }).trimEnd(),
  );
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
    return `Hook "${hookName}" not found. Run \`${formatCliCommand("moltbot hooks list")}\` to see available hooks.`;
  }

  if (opts.json) {
    return JSON.stringify(hook, null, 2);
  }

  const lines: string[] = [];
  const emoji = hook.emoji ?? "🔗";
  const status = hook.eligible
    ? theme.success("✓ Ready")
    : hook.disabled
      ? theme.warn("⏸ Disabled")
      : theme.error("✗ Missing requirements");

  lines.push(`${emoji} ${theme.heading(hook.name)} ${status}`);
  lines.push("");
  lines.push(hook.description);
  lines.push("");

  // Details
  lines.push(theme.heading("Details:"));
  if (hook.managedByPlugin) {
    lines.push(`${theme.muted("  Source:")} ${hook.source} (${hook.pluginId ?? "unknown"})`);
  } else {
    lines.push(`${theme.muted("  Source:")} ${hook.source}`);
  }
  lines.push(`${theme.muted("  Path:")} ${shortenHomePath(hook.filePath)}`);
  lines.push(`${theme.muted("  Handler:")} ${shortenHomePath(hook.handlerPath)}`);
  if (hook.homepage) {
    lines.push(`${theme.muted("  Homepage:")} ${hook.homepage}`);
  }
  if (hook.events.length > 0) {
    lines.push(`${theme.muted("  Events:")} ${hook.events.join(", ")}`);
  }
  if (hook.managedByPlugin) {
    lines.push(theme.muted("  Managed by plugin; enable/disable via hooks CLI not available."));
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
    lines.push(theme.heading("Requirements:"));
    if (hook.requirements.bins.length > 0) {
      const binsStatus = hook.requirements.bins.map((bin) => {
        const missing = hook.missing.bins.includes(bin);
        return missing ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
      });
      lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
    }
    if (hook.requirements.anyBins.length > 0) {
      const anyBinsStatus =
        hook.missing.anyBins.length > 0
          ? theme.error(`✗ (any of: ${hook.requirements.anyBins.join(", ")})`)
          : theme.success(`✓ (any of: ${hook.requirements.anyBins.join(", ")})`);
      lines.push(`${theme.muted("  Any binary:")} ${anyBinsStatus}`);
    }
    if (hook.requirements.env.length > 0) {
      const envStatus = hook.requirements.env.map((env) => {
        const missing = hook.missing.env.includes(env);
        return missing ? theme.error(`✗ ${env}`) : theme.success(`✓ ${env}`);
      });
      lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
    }
    if (hook.requirements.config.length > 0) {
      const configStatus = hook.configChecks.map((check) => {
        return check.satisfied ? theme.success(`✓ ${check.path}`) : theme.error(`✗ ${check.path}`);
      });
      lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
    }
    if (hook.requirements.os.length > 0) {
      const osStatus =
        hook.missing.os.length > 0
          ? theme.error(`✗ (${hook.requirements.os.join(", ")})`)
          : theme.success(`✓ (${hook.requirements.os.join(", ")})`);
      lines.push(`${theme.muted("  OS:")} ${osStatus}`);
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
  lines.push(theme.heading("Hooks Status"));
  lines.push("");
  lines.push(`${theme.muted("Total hooks:")} ${report.hooks.length}`);
  lines.push(`${theme.success("Ready:")} ${eligible.length}`);
  lines.push(`${theme.warn("Not ready:")} ${notEligible.length}`);

  if (notEligible.length > 0) {
    lines.push("");
    lines.push(theme.heading("Hooks not ready:"));
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
  defaultRuntime.log(
    `${theme.success("✓")} Enabled hook: ${hook.emoji ?? "🔗"} ${theme.command(hookName)}`,
  );
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
  defaultRuntime.log(
    `${theme.warn("⏸")} Disabled hook: ${hook.emoji ?? "🔗"} ${theme.command(hookName)}`,
  );
}

export function registerHooksCli(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Manage internal agent hooks")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/hooks", "docs.molt.bot/cli/hooks")}\n`,
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
        defaultRuntime.log(formatHooksList(report, opts));
      } catch (err) {
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
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
        defaultRuntime.log(formatHookInfo(report, name, opts));
      } catch (err) {
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
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
        defaultRuntime.log(formatHooksCheck(report, opts));
      } catch (err) {
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
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
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
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
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
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

          let next: MoltbotConfig = {
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
          defaultRuntime.log(`Linked hook path: ${shortenHomePath(resolved)}`);
          defaultRuntime.log(`Restart the gateway to load hooks.`);
          return;
        }

        const result = await installHooksFromPath({
          path: resolved,
          logger: {
            info: (msg) => defaultRuntime.log(msg),
            warn: (msg) => defaultRuntime.log(theme.warn(msg)),
          },
        });
        if (!result.ok) {
          defaultRuntime.error(result.error);
          process.exit(1);
        }

        let next: MoltbotConfig = {
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
          warn: (msg) => defaultRuntime.log(theme.warn(msg)),
        },
      });
      if (!result.ok) {
        defaultRuntime.error(result.error);
        process.exit(1);
      }

      let next: MoltbotConfig = {
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
          defaultRuntime.log(theme.warn(`No install record for "${hookId}".`));
          continue;
        }
        if (record.source !== "npm") {
          defaultRuntime.log(theme.warn(`Skipping "${hookId}" (source: ${record.source}).`));
          continue;
        }
        if (!record.spec) {
          defaultRuntime.log(theme.warn(`Skipping "${hookId}" (missing npm spec).`));
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
              warn: (msg) => defaultRuntime.log(theme.warn(msg)),
            },
          });
          if (!probe.ok) {
            defaultRuntime.log(theme.error(`Failed to check ${hookId}: ${probe.error}`));
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
            warn: (msg) => defaultRuntime.log(theme.warn(msg)),
          },
        });
        if (!result.ok) {
          defaultRuntime.log(theme.error(`Failed to update ${hookId}: ${result.error}`));
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
      defaultRuntime.log(formatHooksList(report, {}));
    } catch (err) {
      defaultRuntime.error(
        `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });
}
