import type { OpenClawConfig } from "../config/types.openclaw.js";
import { consumeRootOptionToken } from "../infra/cli-root-options.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  resolveManifestToolOwnerInRegistry,
  type PluginManifestCommandAliasRecord,
  type PluginManifestCommandAliasRegistry,
  type PluginManifestToolOwnerRecord,
} from "../plugins/manifest-command-aliases.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
import {
  resolveCliCommandPathPolicy,
  resolveCliNetworkProxyPolicy,
} from "./command-path-policy.js";
import { isReservedNonPluginCommandRoot } from "./command-registration-policy.js";
import { getCoreCliParentDefaultHelpCommands } from "./program/core-command-descriptors.js";
import { getSubCliParentDefaultHelpCommands } from "./program/subcli-descriptors.js";

const ROOT_HELP_ALIASES = new Set(["tools"]);
const SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS = new Set(["setup", "onboard", "configure"]);
const PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS = new Set(["doctor", "gateway", "models", "plugins"]);
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const BARE_PARENT_DEFAULT_HELP_COMMANDS = new Set([
  ...getCoreCliParentDefaultHelpCommands(),
  ...getSubCliParentDefaultHelpCommands(),
]);

function hasHelpFlag(argv: string[]): boolean {
  return hasFlag(argv, "-h") || hasFlag(argv, "--help");
}

function resolveStrictPrecomputedSubcommandHelpCommand(argv: string[]): string | null {
  const args = argv.slice(2);
  let commandName: string | null = null;
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
      if (arg.startsWith("-")) {
        return null;
      }
      if (!PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.has(arg)) {
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

function isBareParentDefaultHelpArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  const [primary, extra] = invocation.commandPath;
  return !invocation.hasHelpOrVersion && primary !== undefined && extra === undefined
    ? BARE_PARENT_DEFAULT_HELP_COMMANDS.has(primary)
    : false;
}

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

export function shouldEnsureCliPath(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (
    invocation.hasHelpOrVersion ||
    shouldStartCrestodianForBareRoot(argv) ||
    isBareParentDefaultHelpArgv(argv)
  ) {
    return false;
  }
  return resolveCliCommandPathPolicy(invocation.commandPath).ensureCliPath;
}

export function shouldUseRootHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH !== "1" &&
    (invocation.isRootHelpInvocation ||
      (invocation.commandPath.length === 1 &&
        ROOT_HELP_ALIASES.has(invocation.commandPath[0] ?? "") &&
        invocation.hasHelpOrVersion) ||
      (invocation.commandPath.length === 1 &&
        invocation.commandPath[0] === "help" &&
        invocation.hasHelpOrVersion))
  );
}

export function shouldUseBrowserHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath.length === 1 &&
    invocation.commandPath[0] === "browser" &&
    hasHelpFlag(argv)
  );
}

export function shouldUseSecretsHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath.length === 1 &&
    invocation.commandPath[0] === "secrets" &&
    hasHelpFlag(argv)
  );
}

export function shouldUseNodesHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath.length === 1 &&
    invocation.commandPath[0] === "nodes" &&
    hasHelpFlag(argv)
  );
}

export function shouldUseSetupOnboardConfigureHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath.length === 1 &&
    SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS.has(invocation.commandPath[0] ?? "") &&
    invocation.hasHelpOrVersion
  );
}

export function resolvePrecomputedSubcommandHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return null;
  }
  return resolveStrictPrecomputedSubcommandHelpCommand(argv);
}

export function shouldStartCrestodianForBareRoot(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return invocation.commandPath.length === 0 && !invocation.hasHelpOrVersion;
}

export function shouldStartCrestodianForModernOnboard(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath[0] === "onboard" &&
    argv.includes("--modern") &&
    !invocation.hasHelpOrVersion
  );
}

export function shouldStartProxyForCli(argv: string[]): boolean {
  const policyArgv = rewriteUpdateFlagArgv(argv);
  const invocation = resolveCliArgvInvocation(policyArgv);
  const [primary] = invocation.commandPath;
  if (invocation.hasHelpOrVersion || !primary) {
    return false;
  }
  if (isBareParentDefaultHelpArgv(policyArgv)) {
    return false;
  }
  return resolveCliNetworkProxyPolicy(policyArgv) === "default";
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: {
    registry?: PluginManifestCommandAliasRegistry;
    resolveCommandAliasOwner?: (params: {
      command: string | undefined;
      config?: OpenClawConfig;
      registry?: PluginManifestCommandAliasRegistry;
    }) => PluginManifestCommandAliasRecord | undefined;
    resolveToolOwner?: (params: {
      toolName: string | undefined;
      config?: OpenClawConfig;
      registry?: PluginManifestCommandAliasRegistry;
    }) => PluginManifestToolOwnerRecord | undefined;
    resolveCliCommandSurfaceOwner?: (params: {
      command: string | undefined;
      config?: OpenClawConfig;
      registry?: PluginManifestCommandAliasRegistry;
    }) => string | undefined;
  },
): string | null {
  const normalizedPluginId = normalizeLowercaseStringOrEmpty(pluginId);
  if (!normalizedPluginId) {
    return null;
  }
  const allow =
    Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0
      ? config.plugins.allow
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeOptionalLowercaseString(entry))
          .filter(Boolean)
      : [];
  const commandAlias = options?.registry
    ? resolveManifestCommandAliasOwnerInRegistry({
        command: normalizedPluginId,
        registry: options.registry,
      })
    : options?.resolveCommandAliasOwner?.({
        command: normalizedPluginId,
        config,
        ...(options?.registry ? { registry: options.registry } : {}),
      });
  const parentPluginId = commandAlias?.pluginId;
  if (parentPluginId) {
    if (allow.length > 0 && !allow.includes(parentPluginId)) {
      if (parentPluginId === normalizedPluginId) {
        return (
          `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
          `\`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to ` +
          `\`plugins.allow\` if you want that bundled plugin CLI surface.`
        );
      }
      return (
        `"${normalizedPluginId}" is not a plugin; it is a command provided by the ` +
        `"${parentPluginId}" plugin. Add "${parentPluginId}" to \`plugins.allow\` ` +
        `instead of "${normalizedPluginId}".`
      );
    }
    if (config?.plugins?.entries?.[parentPluginId]?.enabled === false) {
      return (
        `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
        `\`plugins.entries.${parentPluginId}.enabled=false\`. Re-enable that entry if you want ` +
        "the bundled plugin command surface."
      );
    }
    if (
      commandAlias.kind !== "runtime-slash" &&
      commandAlias.enabledByDefault !== true &&
      config?.plugins?.entries?.[parentPluginId]?.enabled !== true
    ) {
      return (
        `The \`openclaw ${normalizedPluginId}\` command is provided by the ` +
        `"${parentPluginId}" plugin, but that bundled plugin is disabled by default. Run ` +
        `\`openclaw plugins enable ${parentPluginId}\` to enable that CLI surface.`
      );
    }
    if (commandAlias.kind === "runtime-slash") {
      const cliHint = commandAlias.cliCommand
        ? `Use \`openclaw ${commandAlias.cliCommand}\` for related CLI operations, or `
        : "Use ";
      return (
        `"${normalizedPluginId}" is a runtime slash command (/${normalizedPluginId}), not a CLI command. ` +
        `It is provided by the "${parentPluginId}" plugin. ` +
        `${cliHint}\`/${normalizedPluginId}\` in a chat session.`
      );
    }
  }

  if (isReservedNonPluginCommandRoot(normalizedPluginId)) {
    return null;
  }

  const toolOwner = options?.registry
    ? resolveManifestToolOwnerInRegistry({
        toolName: normalizedPluginId,
        registry: options.registry,
      })
    : options?.resolveToolOwner?.({
        toolName: normalizedPluginId,
        config,
        ...(options?.registry ? { registry: options.registry } : {}),
      });
  if (toolOwner) {
    // Apply plugins.allow / plugins.entries[X].enabled to the owning plugin so
    // a disabled/denied plugin's manifest-declared tool name does not get a
    // false attribution. The runtime resolver
    // (resolveManifestToolOwner) already filters by control-plane availability,
    // but pure-registry callers and any future ones still need this guard.
    const ownerEnabled =
      config?.plugins?.entries?.[toolOwner.pluginId]?.enabled !== false &&
      (allow.length === 0 || allow.includes(toolOwner.pluginId));
    if (ownerEnabled) {
      // Per-account / per-tool runtime gates (e.g. Feishu's
      // channels.feishu.enabled / tools.<x> toggles) are not declarable as
      // manifest configSignals, so a positive manifest-availability signal
      // proves "could be loaded if config permits", not "currently registered".
      // Soften the wording when the runtime resolver could only prove
      // manifest-level ownership.
      if (toolOwner.availability === "manifest-only") {
        return (
          `"${normalizedPluginId}" may be provided by the "${toolOwner.pluginId}" plugin ` +
          `as an agent tool, not a CLI subcommand. ` +
          "Run `openclaw --help` to see available CLI subcommands."
        );
      }
      return (
        `"${normalizedPluginId}" is an agent tool available from the "${toolOwner.pluginId}" plugin, ` +
        `not a CLI subcommand. Use it from an agent turn (model tool-use), not the CLI. ` +
        "Run `openclaw --help` to see available CLI subcommands."
      );
    }
  }

  if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
    if (parentPluginId && allow.includes(parentPluginId)) {
      return null;
    }
    const cliCommandSurfaceOwner = options?.resolveCliCommandSurfaceOwner
      ? options.resolveCliCommandSurfaceOwner({
          command: normalizedPluginId,
          config,
          ...(options?.registry ? { registry: options.registry } : {}),
        })
      : options?.registry
        ? resolveManifestCommandAliasOwnerInRegistry({
            command: normalizedPluginId,
            registry: options.registry,
          })?.pluginId
        : undefined;
    const normalizedCliCommandSurfaceOwner =
      normalizeOptionalLowercaseString(cliCommandSurfaceOwner);
    if (!normalizedCliCommandSurfaceOwner) {
      return null;
    }
    if (allow.includes(normalizedCliCommandSurfaceOwner)) {
      return null;
    }
    if (normalizedCliCommandSurfaceOwner !== normalizedPluginId) {
      return (
        `"${normalizedPluginId}" is not a plugin; it is a command provided by the ` +
        `"${normalizedCliCommandSurfaceOwner}" plugin. Add "${normalizedCliCommandSurfaceOwner}" to ` +
        `\`plugins.allow\` instead of "${normalizedPluginId}".`
      );
    }
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to ` +
      `\`plugins.allow\` if you want that bundled plugin CLI surface.`
    );
  }
  if (config?.plugins?.entries?.[normalizedPluginId]?.enabled === false) {
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.entries.${normalizedPluginId}.enabled=false\`. Re-enable that entry if you want ` +
      "the bundled plugin CLI surface."
    );
  }
  return null;
}
