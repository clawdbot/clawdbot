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
import { shouldBypassConfigGuardForCommandPath } from "../command-startup-policy.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallPreactionRequest,
} from "../plugin-install-config-policy.js";
import { isCommandJsonOutputMode } from "./json-mode.js";
import { isParentDefaultHelpAction } from "./parent-default-help.js";

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
    resolvePluginInstallInvalidConfigPolicy(
      resolvePluginInstallPreactionRequest({
        actionCommand,
        commandPath,
        argv: process.argv,
      }),
    ) === "allow-plugin-recovery"
  );
}

function getRootCommand(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function getActionCommandPath(actionCommand: Command): string[] {
  const commandPath: string[] = [];
  let current: Command | null = actionCommand;
  while (current.parent) {
    commandPath.unshift(current.name());
    current = current.parent;
  }
  return commandPath;
}

function getCliLogLevel(actionCommand: Command): LogLevel | undefined {
  const root = getRootCommand(actionCommand);
  if (root.getOptionValueSource("logLevel") !== "cli") {
    return undefined;
  }
  const logLevel = root.getOptionValue("logLevel");
  return typeof logLevel === "string" ? (logLevel as LogLevel) : undefined;
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
    if (isHelpOrVersionInvocation(argv) || isBareParentDefaultHelpInvocation(actionCommand, argv)) {
      return;
    }
    const jsonOutputMode = isCommandJsonOutputMode(actionCommand, argv);
    const { commandPath, startupPolicy } = resolveCliExecutionStartupContext({
      argv,
      protocolCommandPath: getActionCommandPath(actionCommand),
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
    if (
      shouldBypassConfigGuardForCommandPath(commandPath) ||
      isGuidedConfigAction(actionCommand) ||
      isGuidedConfigCommandPath(commandPath)
    ) {
      return;
    }
    let beforeStateMigrations: ((snapshot?: ConfigFileSnapshot) => Promise<boolean>) | undefined;
    let skipPristineStartupStateMigrations = false;
    let skipPristineCoreStateMigrations = false;
    if (isGatewayRunAction(actionCommand)) {
      const {
        prepareGatewayRunBootstrap,
        recheckGatewayRunBootstrap,
        wasPreparedGatewayRunCoreStatePristine,
        wasPreparedGatewayRunStatePristine,
      } = await import("../gateway-cli/pre-bootstrap.js");
      const { resolveGatewayRunOptions } = await import("../gateway-cli/run-options.js");
      const resolvedOptions = resolveGatewayRunOptions(actionCommand.opts(), actionCommand);
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
    await ensureCliExecutionBootstrap({
      runtime: defaultRuntime,
      commandPath,
      startupPolicy,
      allowInvalid: shouldAllowInvalidConfigForAction(actionCommand, commandPath),
      ...(beforeStateMigrations ? { beforeStateMigrations } : {}),
      ...(skipPristineStartupStateMigrations ? { skipPristineStartupStateMigrations: true } : {}),
      ...(skipPristineCoreStateMigrations ? { skipPristineCoreStateMigrations: true } : {}),
      skipConfigGuard: shouldBypassConfigGuardForCommandPath(commandPath),
    });
    if (beforeStateMigrations) {
      const { reloadTrustedGatewayRunEnvironment } =
        await import("../gateway-cli/pre-bootstrap.js");
      await reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime });
    }
  });
}
