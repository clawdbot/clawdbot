// Renders the `openclaw hooks` list, info, and check reports.
// Kept apart from command wiring so each surface stays readable and under the file-size cap.

import {
  decorativeEmoji,
  decorativePrefix,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { summarizeStringEntries } from "../shared/string-sample.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure } from "./failure-output.js";

export type HooksListOptions = {
  agent?: string;
  json?: boolean;
  eligible?: boolean;
  verbose?: boolean;
};

export type HookInfoOptions = {
  agent?: string;
  json?: boolean;
};

export type HooksCheckOptions = {
  agent?: string;
  json?: boolean;
};

function formatHookStatus(hook: HookStatusEntry): string {
  if (hook.loadable) {
    return theme.success("✓ ready");
  }
  if (!hook.enabledByConfig) {
    return theme.warn(decorativePrefix("⏸", "disabled"));
  }
  return theme.error(`✗ ${formatHookBlockedStatusReason(hook)}`);
}

function formatHookBlockedStatusReason(hook: HookStatusEntry): string {
  return hook.blockedReason && hook.blockedReason !== "missing requirements"
    ? hook.blockedReason
    : "missing";
}

function formatHookInfoBlockedStatusReason(hook: HookStatusEntry): string {
  const reason =
    hook.blockedReason && hook.blockedReason !== "missing requirements"
      ? hook.blockedReason
      : "missing requirements";
  return reason ? `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}` : reason;
}

function formatHookName(hook: HookStatusEntry): string {
  const emoji = hook.emoji ?? decorativeEmoji("🔗");
  const name = theme.command(hook.name);
  return emoji ? `${emoji} ${name}` : name;
}

function formatHookSource(hook: HookStatusEntry): string {
  if (!hook.managedByPlugin) {
    return hook.source;
  }
  return `plugin:${hook.pluginId ?? "unknown"}`;
}

export function formatHookMissingSummary(hook: HookStatusEntry, itemLimit?: number): string {
  const formatEntries = (entries: string[]) =>
    itemLimit === undefined
      ? entries.join(", ")
      : summarizeStringEntries({ entries, limit: itemLimit });
  const missing: string[] = [];
  if (hook.enabledByConfig && hook.blockedReason && hook.blockedReason !== "missing requirements") {
    missing.push(hook.blockedReason);
  }
  if (hook.missing.bins.length > 0) {
    missing.push(`bins: ${formatEntries(hook.missing.bins)}`);
  }
  if (hook.missing.anyBins.length > 0) {
    missing.push(`anyBins: ${formatEntries(hook.missing.anyBins)}`);
  }
  if (hook.missing.env.length > 0) {
    missing.push(`env: ${formatEntries(hook.missing.env)}`);
  }
  if (hook.missing.config.length > 0) {
    missing.push(`config: ${formatEntries(hook.missing.config)}`);
  }
  if (hook.missing.os.length > 0) {
    missing.push(`os: ${formatEntries(hook.missing.os)}`);
  }
  return missing.join("; ");
}

/**
 * Format the hooks list output
 */
export function formatHooksList(report: HookStatusReport, opts: HooksListOptions): string {
  const hooks = opts.eligible ? report.hooks.filter((h) => h.loadable) : report.hooks;

  if (opts.json) {
    const jsonReport = {
      workspaceDir: report.workspaceDir,
      managedHooksDir: report.managedHooksDir,
      hooks: hooks.map((h) => ({
        name: h.name,
        description: h.description,
        emoji: h.emoji,
        eligible: h.loadable,
        disabled: !h.enabledByConfig,
        enabledByConfig: h.enabledByConfig,
        requirementsSatisfied: h.requirementsSatisfied,
        loadable: h.loadable,
        blockedReason: h.blockedReason,
        source: h.source,
        pluginId: h.pluginId,
        events: h.events,
        unknownEvents: h.unknownEvents,
        homepage: h.homepage,
        missing: h.missing,
        managedByPlugin: h.managedByPlugin,
      })),
    };
    return JSON.stringify(jsonReport, null, 2);
  }

  if (hooks.length === 0) {
    const message = opts.eligible
      ? `No eligible hooks found. Run \`${formatCliCommand("openclaw hooks list")}\` to see all hooks.`
      : "No hooks found.";
    return message;
  }

  const eligible = hooks.filter((h) => h.loadable);
  const tableWidth = getTerminalTableWidth();
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
  { hooks }: HookStatusReport,
  hookName: string,
  opts: HookInfoOptions,
): string {
  const hook = hooks.find((h) => h.name === hookName) ?? hooks.find((h) => h.hookKey === hookName);

  if (!hook) {
    if (opts.json) {
      const failure = formatCliJsonFailure(`Hook "${hookName}" not found.`);
      return JSON.stringify({ ...failure, hook: hookName }, null, 2);
    }
    return `Hook "${hookName}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`;
  }

  if (opts.json) {
    return JSON.stringify(
      {
        ...hook,
        eligible: hook.loadable,
        disabled: !hook.enabledByConfig,
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  const emoji = hook.emoji ?? decorativeEmoji("🔗");
  const status = hook.loadable
    ? theme.success("✓ Ready")
    : !hook.enabledByConfig
      ? theme.warn(decorativePrefix("⏸", "Disabled"))
      : theme.error(`✗ ${formatHookInfoBlockedStatusReason(hook)}`);

  lines.push(`${emoji ? `${emoji} ` : ""}${theme.heading(hook.name)} ${status}`);
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
  if (hook.unknownEvents.length > 0) {
    lines.push(
      theme.warn(
        `  ⚠ Event${hook.unknownEvents.length === 1 ? "" : "s"} not emitted by core (likely typo): ${hook.unknownEvents.join(", ")}`,
      ),
    );
  }
  if (hook.managedByPlugin) {
    lines.push(theme.muted("  Managed by plugin; enable/disable via hooks CLI not available."));
  }
  if (hook.blockedReason) {
    lines.push(`${theme.muted("  Blocked reason:")} ${hook.blockedReason}`);
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
    const eligible = report.hooks.filter((h) => h.loadable);
    const notEligible = report.hooks.filter((h) => !h.loadable);
    return JSON.stringify(
      {
        total: report.hooks.length,
        eligible: eligible.length,
        notEligible: notEligible.length,
        hooks: {
          eligible: eligible.map((h) => h.name),
          notEligible: notEligible.map((h) => ({
            name: h.name,
            blockedReason: h.blockedReason,
            missing: h.missing,
          })),
        },
      },
      null,
      2,
    );
  }

  const eligible = report.hooks.filter((h) => h.loadable);
  const notEligible = report.hooks.filter((h) => !h.loadable);

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
      if (hook.blockedReason && hook.blockedReason !== "missing requirements") {
        reasons.push(hook.blockedReason);
      }
      if (hook.missing.bins.length > 0) {
        reasons.push(`bins: ${hook.missing.bins.join(", ")}`);
      }
      if (hook.missing.anyBins.length > 0) {
        reasons.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
      }
      if (hook.missing.env.length > 0) {
        reasons.push(`env: ${hook.missing.env.join(", ")}`);
      }
      if (hook.missing.config.length > 0) {
        reasons.push(`config: ${hook.missing.config.join(", ")}`);
      }
      if (hook.missing.os.length > 0) {
        reasons.push(`os: ${hook.missing.os.join(", ")}`);
      }
      const emoji = hook.emoji ?? decorativeEmoji("🔗");
      lines.push(`  ${emoji ? `${emoji} ` : ""}${hook.name} - ${reasons.join("; ")}`);
    }
  }

  return lines.join("\n");
}
