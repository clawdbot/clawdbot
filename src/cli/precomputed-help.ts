import { consumeRootOptionToken } from "../infra/cli-root-options.js";
import { getCommandPathWithRootOptions, hasFlag } from "./argv.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";

type PrecomputedSubcommandHelpName =
  | "doctor"
  | "gateway"
  | "models"
  | "plugins"
  | "sessions"
  | "tasks";

type PrecomputedCommandHelpName = "browser" | "secrets" | "nodes";
type OutputPrecomputedHelpText = () => boolean;

export type PrecomputedCommandHelpDeps = {
  outputPrecomputedBrowserHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedSecretsHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedNodesHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedSubcommandHelpText?: (commandName: PrecomputedSubcommandHelpName) => boolean;
  loadRootHelpRenderOptionsForConfigSensitivePlugins?: (
    env?: NodeJS.ProcessEnv,
  ) => Promise<RootHelpRenderOptions | null>;
  env?: NodeJS.ProcessEnv;
};

const PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS = new Set<PrecomputedSubcommandHelpName>([
  "doctor",
  "gateway",
  "models",
  "plugins",
  "sessions",
  "tasks",
]);
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);

const loadRootHelpLiveConfigModule = async () => await import("./root-help-live-config.js");
const loadRootHelpMetadataModule = async () => await import("./root-help-metadata.js");

function isPrecomputedSubcommandHelpName(value: string): value is PrecomputedSubcommandHelpName {
  return PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.has(value as PrecomputedSubcommandHelpName);
}

function resolvePrecomputedSubcommandHelpCommand(
  argv: string[],
): PrecomputedSubcommandHelpName | null {
  const args = argv.slice(2);
  let commandName: PrecomputedSubcommandHelpName | null = null;
  let sawHelp = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return null;
    }
    if (VERSION_FLAGS.has(arg)) {
      return null;
    }
    if (!commandName) {
      const consumed = consumeRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg.startsWith("-") || !isPrecomputedSubcommandHelpName(arg)) {
        return null;
      }
      commandName = arg;
      continue;
    }
    if (HELP_FLAGS.has(arg)) {
      sawHelp = true;
      continue;
    }
    return null;
  }

  return commandName && sawHelp ? commandName : null;
}

function resolvePrecomputedCommandHelpName(argv: string[]): PrecomputedCommandHelpName | null {
  if (!hasFlag(argv, "--help") && !hasFlag(argv, "-h")) {
    return null;
  }
  const commandPath = getCommandPathWithRootOptions(argv, 2);
  if (commandPath.length !== 1) {
    return null;
  }
  const [commandName] = commandPath;
  return commandName === "browser" || commandName === "secrets" || commandName === "nodes"
    ? commandName
    : null;
}

export async function tryOutputPrecomputedCommandHelp(
  argv: string[],
  deps: PrecomputedCommandHelpDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }

  const commandName = resolvePrecomputedCommandHelpName(argv);
  const subcommandName = commandName ? null : resolvePrecomputedSubcommandHelpCommand(argv);
  if (subcommandName) {
    const outputPrecomputedSubcommandHelpText =
      deps.outputPrecomputedSubcommandHelpText ??
      (await loadRootHelpMetadataModule()).outputPrecomputedSubcommandHelpText;
    return outputPrecomputedSubcommandHelpText(subcommandName);
  }
  if (!commandName) {
    return false;
  }

  if (commandName === "nodes") {
    const loadRootHelpRenderOptionsForConfigSensitivePlugins =
      deps.loadRootHelpRenderOptionsForConfigSensitivePlugins ??
      (await loadRootHelpLiveConfigModule()).loadRootHelpRenderOptionsForConfigSensitivePlugins;
    if (await loadRootHelpRenderOptionsForConfigSensitivePlugins(env)) {
      return false;
    }
  }

  if (commandName === "browser") {
    const outputPrecomputedBrowserHelpText =
      deps.outputPrecomputedBrowserHelpText ??
      (await loadRootHelpMetadataModule()).outputPrecomputedBrowserHelpText;
    return outputPrecomputedBrowserHelpText();
  }
  if (commandName === "secrets") {
    const outputPrecomputedSecretsHelpText =
      deps.outputPrecomputedSecretsHelpText ??
      (await loadRootHelpMetadataModule()).outputPrecomputedSecretsHelpText;
    return outputPrecomputedSecretsHelpText();
  }
  const outputPrecomputedNodesHelpText =
    deps.outputPrecomputedNodesHelpText ??
    (await loadRootHelpMetadataModule()).outputPrecomputedNodesHelpText;
  return outputPrecomputedNodesHelpText();
}
