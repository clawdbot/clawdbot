import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { decorativePrefix } from "../../packages/terminal-core/src/decorative-emoji.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveAgentWorkspaceDir,
  resolveConfiguredAgentId,
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
import { summarizeStringEntries } from "../shared/string-sample.js";
import { resolveOptionFromCommand } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import { ExpectedCliError, rethrowExpectedCliError } from "./failure-output.js";
import { canFallbackToImplicitLocalGateway } from "./gateway-rpc.js";
import {
  formatHookInfo,
  formatHookMissingSummary,
  formatHooksCheck,
  formatHooksList,
  type HookInfoOptions,
  type HooksCheckOptions,
  type HooksListOptions,
} from "./hooks-cli.format.js";
import { runNativeHookRelayCli, type NativeHookRelayCliOptions } from "./native-hook-relay-cli.js";
import { requestExitAfterOneShotOutput } from "./one-shot-exit.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

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
  if (rawAgentId !== undefined && !requested) {
    throw new Error("--agent must not be blank");
  }
  const requestedAgentId = requested ? normalizeAgentId(requested) : undefined;
  if (requestedAgentId) {
    resolveConfiguredAgentId(config, requestedAgentId);
  }
  const agentId =
    requestedAgentId ??
    // Status reporting narrows to one workspace, so it keeps demanding an explicit
    // choice rather than adopting the system agent and hiding the other agents' hooks.
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
  const { callGateway } = await import("../gateway/call.js");
  try {
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
      !(await canFallbackToImplicitLocalGateway({
        config,
        error,
        legacyMethod: "hooks.status",
        legacyAgentId: true,
      }))
    ) {
      throw error;
    }
    // Only implicit local Gateways may use offline or older-Gateway discovery.
    return buildHooksReport(config, target);
  }
}

function resolveHooksAgentOption(command: Command | undefined): string | undefined {
  return resolveOptionFromCommand<string>(command, "agent");
}

function resolveHookSelection(
  report: HookStatusReport,
  hookName: string,
): HookStatusEntry | undefined {
  // A metadata key may alias another hook's name; exact names always win.
  const nameMatches = report.hooks.filter((hook) => hook.name === hookName);
  const matches =
    nameMatches.length > 0 ? nameMatches : report.hooks.filter((hook) => hook.hookKey === hookName);
  if (matches.length > 1) {
    const candidates = summarizeStringEntries({
      entries: matches.map((hook) => `${hook.name} (${hook.hookKey})`),
      limit: 5,
    });
    throw new Error(
      `Hook "${hookName}" is ambiguous; matches: ${candidates}. Use a unique hook name or hook key.`,
    );
  }
  return matches[0];
}

function writeHooksOutput(value: string, json: boolean | undefined): void {
  if (json) {
    defaultRuntime.writeStdout(value);
    return;
  }
  defaultRuntime.log(value);
}

async function runOneShotHooksCliAction(
  action: () => Promise<number | void>,
  failureOwner: "command" | "root" = "command",
): Promise<void> {
  const result = await action().catch((err: unknown) => {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    const humanOutput = `${theme.error("Error:")} ${message}`;
    if (failureOwner === "root") {
      throw new ExpectedCliError({ message, humanOutput, machineOutput: message });
    }
    defaultRuntime.error(humanOutput);
    defaultRuntime.exit(1);
    throw new Error("unreachable");
  });
  const exitCode = typeof result === "number" ? result : 0;
  // CLI setup and handlers can leave ref'd handles behind. Defer exit until
  // runCli finishes shared teardown and drains both output streams.
  requestExitAfterOneShotOutput(defaultRuntime, exitCode);
}
async function setHookEnabled(hookName: string, enabled: boolean, agentId?: string): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  const config = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const hook = resolveHookSelection(
    buildHooksReport(config, resolveHooksReportTarget(config, agentId)),
    hookName,
  );
  if (!hook) {
    throw new Error(
      `Hook "${hookName}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`,
    );
  }
  if (hook.managedByPlugin) {
    throw new Error(
      `Hook "${hookName}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`,
    );
  }
  if (enabled && !hook.requirementsSatisfied) {
    const missing = formatHookMissingSummary(hook, 3);
    const installHint = hook.install.length
      ? ` Install options: ${summarizeStringEntries({
          entries: hook.install.map((option) => option.label),
          limit: 3,
        })}.`
      : "";
    throw new Error(
      `Hook "${hookName}" is not eligible; missing ${missing}.${installHint} Run \`${formatCliCommand(`openclaw hooks info ${hookName}`)}\` for details.`,
    );
  }
  const entries = { ...config.hooks?.internal?.entries };
  entries[hook.hookKey] = { ...entries[hook.hookKey], enabled };
  const nextConfig: OpenClawConfig = {
    ...config,
    hooks: {
      ...config.hooks,
      internal: {
        ...config.hooks?.internal,
        ...(enabled ? { enabled: true } : {}),
        entries,
      },
    },
  };

  await replaceConfigFile({
    nextConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });
  const prefix = enabled
    ? `${theme.success("✓")} Enabled hook:`
    : theme.warn(decorativePrefix("⏸", "Disabled hook:"));
  const name = hook.emoji
    ? `${hook.emoji} ${theme.command(hook.name)}`
    : decorativePrefix("🔗", theme.command(hook.name));
  defaultRuntime.log(`${prefix} ${name}`);
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
    if (parentAgent !== undefined && !parentAgent.trim()) {
      throw new Error("--agent must not be blank");
    }
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
      }, "root"),
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
        const hook = resolveHookSelection(report, name);
        writeHooksOutput(formatHookInfo(hook, name, { ...opts, json }), json);
        return hook ? 0 : 1;
      }, "root"),
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
      }, "root"),
    );

  hooks
    .command("enable <name>")
    .description("Enable a hook")
    .option("--agent <id>", "Agent id whose workspace to inspect")
    .action(async (name, _opts: { agent?: string }, command: Command) =>
      runOneShotHooksCliAction(async () => {
        await setHookEnabled(name, true, resolveHooksAgentOption(command));
      }),
    );

  hooks
    .command("disable <name>")
    .description("Disable a hook")
    .option("--agent <id>", "Agent id whose workspace to inspect")
    .action(async (name, _opts: { agent?: string }, command: Command) =>
      runOneShotHooksCliAction(async () => {
        await setHookEnabled(name, false, resolveHooksAgentOption(command));
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
    }, "root"),
  );
}
