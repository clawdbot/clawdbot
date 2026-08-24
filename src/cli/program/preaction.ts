// Global Commander pre-action hook: startup presentation, config guard, logging, and plugin preflight.
import type { Command } from "commander";
import type { ConfigFileSnapshot } from "../../config/types.js";
import { setVerbose } from "../../globals.js";
import type { LogLevel } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { getVerboseFlag, isHelpOrVersionInvocation } from "../argv.js";
import { resolveCliName } from "../cli-name.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
  resolveCliExecutionStartupContext,
} from "../command-execution-startup.js";
import { inheritOptionFromParent } from "../command-options.js";
import { applyResolvedCommandOutputMode } from "../json-output-mode.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallPreactionRequest,
} from "../plugin-install-config-policy.js";
import { getCommanderCommandPath, hasCommanderOptionToken } from "./commander-parse-facts.js";
import { isCommandJsonOutputMode } from "./json-mode.js";
import { isParentDefaultHelpAction } from "./parent-default-help.js";

const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "-V", "--version"]);

function setProcessTitleForCommand(actionCommand: Command) {
  let current: Command = actionCommand;
  while (current.parent && current.parent.parent) {
    current = current.parent;
  }
  const name = current.name();
  const cliName = resolveCliName();
  if (!name || name === cliName) {
    return;
  }
  process.title = `${cliName}-${name}`;
}

function shouldAllowInvalidConfigForAction(actionCommand: Command, commandPath: string[]): boolean {
  return (
    commandPath[0] === "update" ||
    resolvePluginInstallInvalidConfigPolicy(
      resolvePluginInstallPreactionRequest({
        actionCommand,
        commandPath,
        argv: process.argv,
      }),
    ) === "allow-plugin-recovery"
  );
}

function getCliLogLevel(actionCommand: Command): LogLevel | undefined {
  if (actionCommand.getOptionValueSourceWithGlobals("logLevel") !== "cli") {
    return undefined;
  }
  const logLevel = actionCommand.optsWithGlobals<{ logLevel?: unknown }>().logLevel;
  return typeof logLevel === "string" ? (logLevel as LogLevel) : undefined;
}

function getStateMigrationAgentId(actionCommand: Command): string | undefined {
  if (!actionCommand.options.some((option) => option.attributeName() === "agent")) {
    return undefined;
  }
  const value =
    actionCommand.getOptionValueSource("agent") === "cli"
      ? actionCommand.getOptionValue("agent")
      : inheritOptionFromParent(actionCommand, "agent", "cli");
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isBareParentDefaultHelpInvocation(actionCommand: Command, argv: string[]): boolean {
  if (!isParentDefaultHelpAction(actionCommand)) {
    return false;
  }
  const { commandPath } = resolveCliArgvInvocation(argv);
  const [primary, extra] = commandPath;
  if (extra !== undefined || !primary) {
    return false;
  }
  return primary === actionCommand.name() || actionCommand.aliases().includes(primary);
}

function isGuidedConfigAction(actionCommand: Command): boolean {
  return actionCommand.name() === "config" && !actionCommand.parent?.parent;
}

function isGuidedConfigCommandPath(commandPath: string[]): boolean {
  const [primary, secondary, extra] = commandPath;
  if (primary !== "config" || extra !== undefined) {
    return false;
  }
  return (
    secondary !== "get" &&
    secondary !== "set" &&
    secondary !== "patch" &&
    secondary !== "unset" &&
    secondary !== "file" &&
    secondary !== "schema" &&
    secondary !== "validate"
  );
}

function isGatewayRunAction(actionCommand: Command): boolean {
  if (actionCommand.name() === "gateway") {
    return actionCommand.parent?.parent === null;
  }
  return (
    actionCommand.name() === "run" &&
    actionCommand.parent?.name() === "gateway" &&
    actionCommand.parent.parent?.parent === null
  );
}

/** Register global pre-action bootstrap hooks for every non-help command invocation. */
export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;
    const helpOrVersionWasOptionValue = hasCommanderOptionToken(
      actionCommand,
      argv,
      HELP_OR_VERSION_FLAGS,
      "value",
    );
    if (
      (isHelpOrVersionInvocation(argv) && !helpOrVersionWasOptionValue) ||
      isBareParentDefaultHelpInvocation(actionCommand, argv)
    ) {
      return;
    }
    const jsonOutputMode = isCommandJsonOutputMode(actionCommand, argv);
    applyResolvedCommandOutputMode(jsonOutputMode);
    const { commandPath, startupPolicy } = resolveCliExecutionStartupContext({
      argv,
      commandPath: getCommanderCommandPath(actionCommand),
      jsonOutputMode,
      env: process.env,
    });
    await applyCliExecutionStartupPresentation({
      startupPolicy,
      version: programVersion,
    });
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    setVerbose(verbose);
    const cliLogLevel = getCliLogLevel(actionCommand);
    if (cliLogLevel) {
      process.env.OPENCLAW_LOG_LEVEL = cliLogLevel;
    }
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
    if (isGuidedConfigAction(actionCommand) || isGuidedConfigCommandPath(commandPath)) {
      return;
    }
    if (startupPolicy.skipConfigGuard) {
      // Config validation and plugin activation are independent startup policies.
      // A cold config read must not suppress a plugin runtime explicitly required by the command.
      await ensureCliExecutionBootstrap({
        runtime: defaultRuntime,
        commandPath,
        startupPolicy,
        skipConfigGuard: true,
      });
      return;
    }
    let beforeStateMigrations: ((snapshot?: ConfigFileSnapshot) => Promise<boolean>) | undefined;
    let skipPristineStartupStateMigrations = false;
    let skipPristineCoreStateMigrations = false;
    let allowInvalid = shouldAllowInvalidConfigForAction(actionCommand, commandPath);
    if (isGatewayRunAction(actionCommand)) {
      const {
        prepareGatewayRunBootstrap,
        recheckGatewayRunBootstrap,
        wasPreparedGatewayRunCoreStatePristine,
        wasPreparedGatewayRunStatePristine,
      } = await import("../gateway-cli/pre-bootstrap.js");
      const { resolveGatewayRunOptions } = await import("../gateway-cli/run-options.js");
      const resolvedOptions = resolveGatewayRunOptions(actionCommand.opts(), actionCommand);
      allowInvalid ||= resolvedOptions.allowUnconfigured === true;
      const opts = {
        force: resolvedOptions.force === true,
        reset: resolvedOptions.reset === true,
      };
      const shouldBootstrap = await prepareGatewayRunBootstrap({ opts, runtime: defaultRuntime });
      if (!shouldBootstrap) {
        return;
      }
      skipPristineStartupStateMigrations = wasPreparedGatewayRunStatePristine();
      skipPristineCoreStateMigrations = wasPreparedGatewayRunCoreStatePristine();
      beforeStateMigrations = (snapshot) =>
        recheckGatewayRunBootstrap({
          opts,
          runtime: defaultRuntime,
          ...(snapshot ? { snapshot } : {}),
        });
    }
    const stateMigrationAgentId = getStateMigrationAgentId(actionCommand);
    if (stateMigrationAgentId) {
      const existingGuard = beforeStateMigrations;
      beforeStateMigrations = async (snapshot) => {
        if (snapshot) {
          const { isValidAgentId, normalizeAgentId } =
            await import("@openclaw/normalization-core/agent-id");
          if (isValidAgentId(stateMigrationAgentId)) {
            const [{ listAgentIds }, { retainLegacyDefaultAgentId }] = await Promise.all([
              import("../../agents/agent-scope-config.js"),
              import("../../config/legacy.default-agent-owner.js"),
            ]);
            const agentId = normalizeAgentId(stateMigrationAgentId);
            if (listAgentIds(snapshot.sourceConfig).includes(agentId)) {
              retainLegacyDefaultAgentId(snapshot.sourceConfig, agentId);
            }
          }
        }
        return (await existingGuard?.(snapshot)) ?? true;
      };
    }
    await ensureCliExecutionBootstrap({
      runtime: defaultRuntime,
      commandPath,
      startupPolicy,
      allowInvalid,
      ...(beforeStateMigrations ? { beforeStateMigrations } : {}),
      ...(skipPristineStartupStateMigrations ? { skipPristineStartupStateMigrations: true } : {}),
      ...(skipPristineCoreStateMigrations ? { skipPristineCoreStateMigrations: true } : {}),
    });
    if (beforeStateMigrations && isGatewayRunAction(actionCommand)) {
      const { reloadTrustedGatewayRunEnvironment } =
        await import("../gateway-cli/pre-bootstrap.js");
      await reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime });
    }
  });
}
