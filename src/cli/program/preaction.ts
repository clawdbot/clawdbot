import type { Command } from "commander";
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

function getCliLogLevel(actionCommand: Command): LogLevel | undefined {
  const root = getRootCommand(actionCommand);
  if (typeof root.getOptionValueSource !== "function") {
    return undefined;
  }
  if (root.getOptionValueSource("logLevel") !== "cli") {
    return undefined;
  }
  const logLevel = root.opts<Record<string, unknown>>().logLevel;
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
    await ensureCliExecutionBootstrap({
      runtime: defaultRuntime,
      commandPath,
      startupPolicy,
      allowInvalid: shouldAllowInvalidConfigForAction(actionCommand, commandPath),
      skipConfigGuard: shouldBypassConfigGuardForCommandPath(commandPath),
    });
  });
}
