import chalk from "chalk";
import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  buildWorkspaceHookStatus,
  type HookStatusEntry,
  type HookStatusReport,
} from "../hooks/hooks-status.js";
import { loadConfig, writeConfigFile } from "../config/io.js";

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
    return `${emoji} ${name} ${status}${missingStr}\n   ${desc}`;
  }

  return `${emoji} ${name} ${status} - ${desc}`;
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
        events: h.events,
        homepage: h.homepage,
        missing: h.missing,
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
  lines.push(
    chalk.bold.cyan("Internal Hooks") + chalk.gray(` (${eligible.length}/${hooks.length} ready)`),
  );
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
  lines.push(`  Source: ${hook.source}`);
  lines.push(`  Path: ${chalk.gray(hook.filePath)}`);
  lines.push(`  Handler: ${chalk.gray(hook.handlerPath)}`);
  if (hook.homepage) {
    lines.push(`  Homepage: ${chalk.blue(hook.homepage)}`);
  }
  if (hook.events.length > 0) {
    lines.push(`  Events: ${hook.events.join(", ")}`);
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
        return check.satisfied
          ? chalk.green(`✓ ${check.path}`)
          : chalk.red(`✗ ${check.path}`);
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
  lines.push(chalk.bold.cyan("Internal Hooks Status"));
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
      if (hook.missing.config.length > 0)
        reasons.push(`config: ${hook.missing.config.join(", ")}`);
      if (hook.missing.os.length > 0) reasons.push(`os: ${hook.missing.os.join(", ")}`);
      lines.push(`  ${hook.emoji ?? "🔗"} ${hook.name} - ${reasons.join("; ")}`);
    }
  }

  return lines.join("\n");
}

export async function enableHook(hookName: string): Promise<void> {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const report = buildWorkspaceHookStatus(workspaceDir, { config });
  const hook = report.hooks.find((h) => h.name === hookName);

  if (!hook) {
    throw new Error(`Hook "${hookName}" not found`);
  }

  if (!hook.eligible) {
    throw new Error(`Hook "${hookName}" is not eligible (missing requirements)`);
  }

  // Update config
  const entries = { ...(config.hooks?.internal?.entries ?? {}) };
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

  writeConfigFile(nextConfig);
  console.log(`${chalk.green("✓")} Enabled hook: ${hook.emoji ?? "🔗"} ${hookName}`);
}

export async function disableHook(hookName: string): Promise<void> {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const report = buildWorkspaceHookStatus(workspaceDir, { config });
  const hook = report.hooks.find((h) => h.name === hookName);

  if (!hook) {
    throw new Error(`Hook "${hookName}" not found`);
  }

  // Update config
  const entries = { ...(config.hooks?.internal?.entries ?? {}) };
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

  writeConfigFile(nextConfig);
  console.log(`${chalk.yellow("⏸")} Disabled hook: ${hook.emoji ?? "🔗"} ${hookName}`);
}

export function registerInternalHooksSubcommands(hooksCommand: Command): void {
  // Add "internal" subcommand to existing "hooks" command
  const internal = hooksCommand
    .command("internal")
    .description("Manage internal agent hooks")
    .alias("int");

  // list command
  internal
    .command("list")
    .description("List all internal hooks")
    .option("--eligible", "Show only eligible hooks", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const report = buildWorkspaceHookStatus(workspaceDir, { config });
        console.log(formatHooksList(report, opts));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // info command
  internal
    .command("info <name>")
    .description("Show detailed information about a hook")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const report = buildWorkspaceHookStatus(workspaceDir, { config });
        console.log(formatHookInfo(report, name, opts));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // check command
  internal
    .command("check")
    .description("Check hooks eligibility status")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const report = buildWorkspaceHookStatus(workspaceDir, { config });
        console.log(formatHooksCheck(report, opts));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // enable command
  internal
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

  // disable command
  internal
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

  // Default action (no subcommand) - show list
  internal.action(async () => {
    try {
      const config = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
      const report = buildWorkspaceHookStatus(workspaceDir, { config });
      console.log(formatHooksList(report, {}));
    } catch (err) {
      console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
}
