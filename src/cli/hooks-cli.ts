import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  decorativeEmoji,
  decorativePrefix,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope.js";
import { getRuntimeConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildWorkspaceHookStatus,
  type HookStatusEntry,
  type HookStatusReport,
} from "../hooks/hooks-status.js";
import { resolveHookEntries } from "../hooks/policy.js";
import { loadWorkspaceHookEntries } from "../hooks/workspace.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadGatewayStartupPluginPlanWithMetadata } from "../plugins/channel-plugin-ids.js";
import { buildPluginDiagnosticsReport } from "../plugins/status.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { resolveOptionFromCommand } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import { runNativeHookRelayCli, type NativeHookRelayCliOptions } from "./native-hook-relay-cli.js";
import { requestExitAfterOneShotOutput } from "./one-shot-exit.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

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

type HooksUpdateOptions = {
  acknowledgeInstallPolicyWarning?: boolean;
  all?: boolean;
  dryRun?: boolean;
};

type HooksInstallOptions = {
  acknowledgeInstallPolicyWarning?: boolean;
  force?: boolean;
  link?: boolean;
  pin?: boolean;
};

const GATEWAY_HOOKS_STATUS_TIMEOUT_MS = 1_500;

type HooksReportTarget = {
  agentId: string;
  workspaceDir: string;
};

function resolveHooksReportTarget(config: OpenClawConfig, rawAgentId?: string): HooksReportTarget {
  const requested = rawAgentId?.trim();
  const requestedAgentId = requested ? normalizeAgentId(requested) : undefined;
  if (requestedAgentId && !listAgentIds(config).includes(requestedAgentId)) {
    throw new Error(
      `Unknown agent id "${requested}". Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
  }
  const agentId =
    requestedAgentId ??
    tryResolveLegacyCompatibilityAgentId(config) ??
    resolveDefaultAgentId(config, {
      surface: "hooks status reporting",
      hint: "Pass --agent <id> to select a configured agent.",
    });
  return { agentId, workspaceDir: resolveAgentWorkspaceDir(config, agentId) };
}

function buildHooksReport(config: OpenClawConfig, target: HooksReportTarget): HookStatusReport {
  // Plugin-managed and workspace hooks share one resolved policy view for status/actions.
  const workspaceDir = target.workspaceDir;
  const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config });
  // Native plugin hooks only exist after registration. Match the Gateway's startup
  // plan so active hooks remain visible without executing unrelated installed plugins.
  const startup = loadGatewayStartupPluginPlanWithMetadata({
    config,
    workspaceDir,
    env: process.env,
  });
  const pluginReport = buildPluginDiagnosticsReport({
    config,
    workspaceDir,
    onlyPluginIds: startup.plan.pluginIds,
    metadataSnapshot: startup.metadataSnapshot,
  });
  const pluginEntries = pluginReport.hooks.map((hook) => hook.entry);
  const entries = resolveHookEntries([...pluginEntries, ...workspaceEntries]);
  return buildWorkspaceHookStatus(workspaceDir, { config, entries });
}

async function loadHooksReport(agentId?: string): Promise<HookStatusReport> {
  const config = getRuntimeConfig({ skipPluginValidation: true });
  const target = resolveHooksReportTarget(config, agentId);
  try {
    const { callGateway } = await import("../gateway/call.js");
    return await callGateway<HookStatusReport>({
      config,
      method: "hooks.status",
      params: { agentId: target.agentId },
      timeoutMs: GATEWAY_HOOKS_STATUS_TIMEOUT_MS,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "GatewayClientRequestError" &&
      !(
        (error as Error & { gatewayCode?: unknown }).gatewayCode === "INVALID_REQUEST" &&
        /^(?:unknown method: hooks\.status|invalid hooks\.status params(?::|$))/iu.test(
          error.message,
        )
      )
    ) {
      throw error;
    }
    // Unavailable and older Gateways retain the selected owner for local read-only discovery.
    return buildHooksReport(config, target);
  }
}

function resolveHooksAgentOption(command: Command | undefined): string | undefined {
  return resolveOptionFromCommand<string>(command, "agent");
}

function resolveHookForToggle(
  report: HookStatusReport,
  hookName: string,
  opts?: { requireEligible?: boolean },
): HookStatusEntry {
  const nameMatches = report.hooks.filter((hook) => hook.name === hookName);
  const matches =
    nameMatches.length > 0 ? nameMatches : report.hooks.filter((hook) => hook.hookKey === hookName);
  if (matches.length > 1) {
    throw new Error(`Hook "${hookName}" is ambiguous; use a unique hook name or hook key`);
  }
  const hook = matches[0];
  if (!hook) {
    throw new Error(`Hook "${hookName}" not found`);
  }
  if (hook.managedByPlugin) {
    throw new Error(
      `Hook "${hookName}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`,
    );
  }
  if (opts?.requireEligible && !hook.requirementsSatisfied) {
    throw new Error(`Hook "${hookName}" is not eligible (missing requirements)`);
  }
  return hook;
}

function buildConfigWithHookEnabled(params: {
  config: OpenClawConfig;
  hookName: string;
  enabled: boolean;
  ensureHooksEnabled?: boolean;
}): OpenClawConfig {
  const entries = { ...params.config.hooks?.internal?.entries };
  entries[params.hookName] = { ...entries[params.hookName], enabled: params.enabled };

  const internal = {
    ...params.config.hooks?.internal,
    ...(params.ensureHooksEnabled ? { enabled: true } : {}),
    entries,
  };

  return {
    ...params.config,
    hooks: {
      ...params.config.hooks,
      internal,
    },
  };
}

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

function formatHookMissingSummary(hook: HookStatusEntry): string {
  const missing: string[] = [];
  if (hook.enabledByConfig && hook.blockedReason && hook.blockedReason !== "missing requirements") {
    missing.push(hook.blockedReason);
  }
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

function exitHooksCliWithError(err: unknown): never {
  defaultRuntime.error(`${theme.error("Error:")} ${formatErrorMessage(err)}`);
  defaultRuntime.exit(1);
  throw new Error("unreachable");
}

function writeHooksOutput(value: string, json: boolean | undefined): void {
  if (json) {
    defaultRuntime.writeStdout(value);
    return;
  }
  defaultRuntime.log(value);
}

async function runHooksCliAction<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (err) {
    return exitHooksCliWithError(err);
  }
}

async function runOneShotHooksCliAction(action: () => Promise<number | void>): Promise<void> {
  const result = await runHooksCliAction(action);
  const exitCode = typeof result === "number" ? result : 0;
  // CLI setup and handlers can leave ref'd handles behind. Defer exit until
  // runCli finishes shared teardown and drains both output streams.
  requestExitAfterOneShotOutput(defaultRuntime, exitCode);
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
  report: HookStatusReport,
  hookName: string,
  opts: HookInfoOptions,
): string {
  const hook = report.hooks.find((h) => h.name === hookName || h.hookKey === hookName);

  if (!hook) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", hook: hookName }, null, 2);
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

async function enableHook(hookName: string, agentId?: string): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  const config = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const hook = resolveHookForToggle(
    buildHooksReport(config, resolveHooksReportTarget(config, agentId)),
    hookName,
    { requireEligible: true },
  );
  const nextConfig = buildConfigWithHookEnabled({
    config,
    hookName: hook.hookKey,
    enabled: true,
    ensureHooksEnabled: true,
  });

  await replaceConfigFile({
    nextConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });
  defaultRuntime.log(
    `${theme.success("✓")} Enabled hook: ${hook.emoji ? `${hook.emoji} ${theme.command(hook.name)}` : decorativePrefix("🔗", theme.command(hook.name))}`,
  );
}

async function disableHook(hookName: string, agentId?: string): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  const config = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const hook = resolveHookForToggle(
    buildHooksReport(config, resolveHooksReportTarget(config, agentId)),
    hookName,
  );
  const nextConfig = buildConfigWithHookEnabled({
    config,
    hookName: hook.hookKey,
    enabled: false,
  });

  await replaceConfigFile({
    nextConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });
  defaultRuntime.log(
    `${theme.warn(decorativePrefix("⏸", "Disabled hook:"))} ${hook.emoji ? `${hook.emoji} ${theme.command(hook.name)}` : decorativePrefix("🔗", theme.command(hook.name))}`,
  );
}

export function registerHooksCli(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Manage internal agent hooks")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/hooks", "docs.openclaw.ai/cli/hooks")}\n`,
    );
  const hasJsonOutput = (opts: { json?: boolean } | undefined): boolean =>
    Boolean(opts?.json || hooks.opts<{ json?: boolean }>().json);
  hooks.hook("preAction", (_thisCommand, actionCommand) => {
    const parentAgent = hooks.opts<{ agent?: string }>().agent;
    if (
      parentAgent &&
      actionCommand !== hooks &&
      !new Set(["list", "info", "check", "enable", "disable"]).has(actionCommand.name())
    ) {
      throw new Error(
        `openclaw hooks ${actionCommand.name()} does not support --agent; the option only selects an owner for read-only hook reports.`,
      );
    }
  });

  hooks
    .command("list")
    .description("List all hooks")
    .option("--agent <id>", "Agent id to inspect")
    .option("--eligible", "Show only eligible hooks", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts: HooksListOptions, command: Command) =>
      runOneShotHooksCliAction(async () => {
        const report = await loadHooksReport(resolveHooksAgentOption(command));
        const json = hasJsonOutput(opts);
        writeHooksOutput(formatHooksList(report, { ...opts, json }), json);
      }),
    );

  hooks
    .command("info <name>")
    .description("Show detailed information about a hook")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts: HookInfoOptions, command: Command) =>
      runOneShotHooksCliAction(async () => {
        const report = await loadHooksReport(resolveHooksAgentOption(command));
        const json = hasJsonOutput(opts);
        writeHooksOutput(formatHookInfo(report, name, { ...opts, json }), json);
        return report.hooks.some((hook) => hook.name === name || hook.hookKey === name) ? 0 : 1;
      }),
    );

  hooks
    .command("check")
    .description("Check hooks eligibility status")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output as JSON", false)
    .action(async (opts: HooksCheckOptions, command: Command) =>
      runOneShotHooksCliAction(async () => {
        const report = await loadHooksReport(resolveHooksAgentOption(command));
        const json = hasJsonOutput(opts);
        writeHooksOutput(formatHooksCheck(report, { ...opts, json }), json);
      }),
    );

  hooks
    .command("enable <name>")
    .description("Enable a hook")
    .option("--agent <id>", "Agent id whose workspace to inspect")
    .action(async (name, _opts: { agent?: string }, command: Command) =>
      runOneShotHooksCliAction(async () => {
        await enableHook(name, resolveHooksAgentOption(command));
      }),
    );

  hooks
    .command("disable <name>")
    .description("Disable a hook")
    .option("--agent <id>", "Agent id whose workspace to inspect")
    .action(async (name, _opts: { agent?: string }, command: Command) =>
      runOneShotHooksCliAction(async () => {
        await disableHook(name, resolveHooksAgentOption(command));
      }),
    );

  hooks
    .command("relay", { hidden: true })
    .description("Internal native harness hook relay")
    .requiredOption("--provider <provider>", "Native harness provider")
    .requiredOption("--relay-id <id>", "Native hook relay id")
    .option("--state-db <path>", "Shared state database path")
    .option("--generation <generation>", "Native hook relay registration generation")
    .requiredOption("--event <event>", "Native hook event")
    .option(
      "--pre-tool-use-unavailable <mode>",
      "PreToolUse fallback mode when the originating relay is unavailable",
    )
    .option("--timeout <ms>", "Gateway timeout in ms", "5000")
    .action(async (opts: NativeHookRelayCliOptions) =>
      runOneShotHooksCliAction(() => runNativeHookRelayCli(opts)),
    );

  hooks
    .command("install")
    .description("Deprecated: install a hook pack via `openclaw plugins install`")
    .argument("<path-or-spec>", "Path to a hook pack or npm package spec")
    .option("-l, --link", "Link a local path instead of copying", false)
    .option("--pin", "Record npm installs as exact resolved <name>@<version>", false)
    .option("--force", "Confirm non-ClawHub sources and overwrite an existing hook pack", false)
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .action(async (raw: string, opts: HooksInstallOptions) => {
      defaultRuntime.log(
        theme.warn("`openclaw hooks install` is deprecated; use `openclaw plugins install`."),
      );
      await runPluginInstallCommand({
        raw,
        opts,
        allowInstallPolicyWarningPrompt: true,
        invalidateRuntimeCache: false,
      });
    });

  hooks
    .command("update")
    .description("Deprecated: update hook packs via `openclaw plugins update`")
    .argument("[id]", "Hook pack id (omit with --all)")
    .option("--all", "Update all tracked hooks", false)
    .option("--dry-run", "Show what would change without writing", false)
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .action(async (id: string | undefined, opts: HooksUpdateOptions) => {
      defaultRuntime.log(
        theme.warn("`openclaw hooks update` is deprecated; use `openclaw plugins update`."),
      );
      await runPluginUpdateCommand({ id, opts });
    });

  hooks.action(async (opts: HooksListOptions, command: Command) =>
    runOneShotHooksCliAction(async () => {
      const report = await loadHooksReport(resolveHooksAgentOption(command));
      const json = hasJsonOutput(opts);
      writeHooksOutput(formatHooksList(report, { ...opts, json }), json);
    }),
  );
}
