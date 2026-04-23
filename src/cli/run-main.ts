import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { enableConsoleCapture } from "../logging.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { resolveManifestCommandAliasOwner } from "../plugins/manifest-command-aliases.runtime.js";
import { hasMemoryRuntime } from "../plugins/memory-state.js";
import { maybeWarnAboutDebugProxyCoverage } from "../proxy-capture/coverage.js";
import {
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
} from "../proxy-capture/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { shouldEnsureCliPathForCommandPath } from "./command-startup-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

async function closeCliMemoryManagers(): Promise<void> {
  if (!hasMemoryRuntime()) {
    return;
  }
  try {
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // Best-effort teardown for short-lived CLI processes.
  }
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
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  return shouldEnsureCliPathForCommandPath(invocation.commandPath);
}

export function shouldUseRootHelpFastPath(argv: string[]): boolean {
  return resolveCliArgvInvocation(argv).isRootHelpInvocation;
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
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
  const commandAlias = resolveManifestCommandAliasOwner({
    command: normalizedPluginId,
    config,
    registry: options?.registry,
  });
  const parentPluginId = commandAlias?.pluginId;
  if (parentPluginId) {
    if (allow.length > 0 && !allow.includes(parentPluginId)) {
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

  if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
    if (parentPluginId && allow.includes(parentPluginId)) {
      return null;
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

function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

export async function runCli(argv: string[] = process.argv) {
  const originalArgv = normalizeWindowsArgv(argv);
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    throw new Error(parsedContainer.error);
  }
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;
  if (containerTargetName && parsedProfile.profile) {
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  const containerTarget = maybeRunCliInContainer(originalArgv);
  if (containerTarget.handled) {
    if (containerTarget.exitCode !== 0) {
      process.exitCode = containerTarget.exitCode;
    }
    return;
  }
  let normalizedArgv = parsedProfile.argv;

  if (shouldLoadCliDotEnv()) {
    const { loadCliDotEnv } = await import("./dotenv.js");
    loadCliDotEnv({ quiet: true });
  }
  normalizeEnv();
  initializeDebugProxyCapture("cli");
  process.once("exit", () => {
    finalizeDebugProxyCapture();
  });
  ensureGlobalUndiciEnvProxyDispatcher();
  maybeWarnAboutDebugProxyCoverage();
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  try {
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedRootHelpText } = await import("./root-help-metadata.js");
      if (!outputPrecomputedRootHelpText()) {
        const { outputRootHelp } = await import("./program/root-help.js");
        await outputRootHelp();
      }
      return;
    }

    if (await tryRouteCli(normalizedArgv)) {
      return;
    }

    // Capture all console output into structured logs while keeping stdout/stderr behavior.
    enableConsoleCapture();

    const [
      { buildProgram },
      { runFatalErrorHooks },
      { installUnhandledRejectionHandler },
      { restoreTerminalState },
    ] = await Promise.all([
      import("./program.js"),
      import("../infra/fatal-error-hooks.js"),
      import("../infra/unhandled-rejections.js"),
      import("../terminal/restore.js"),
    ]);
    const program = buildProgram();

    // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
    // These log the error and exit gracefully instead of crashing without trace.
    installUnhandledRejectionHandler();

    process.on("uncaughtException", (error) => {
      console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
      for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
        console.error("[openclaw]", message);
      }
      restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
      process.exit(1);
    });

    const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
    const invocation = resolveCliArgvInvocation(parseArgv);
    // Register the primary command (builtin or subcli) so help and command parsing
    // are correct even with lazy command registration.
    const { primary } = invocation;
    if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
      const { getProgramContext } = await import("./program/program-context.js");
      const ctx = getProgramContext(program);
      if (ctx) {
        const { registerCoreCliByName } = await import("./program/command-registry.js");
        await registerCoreCliByName(program, ctx, primary, parseArgv);
      }
      const { registerSubCliByName } = await import("./program/register.subclis.js");
      await registerSubCliByName(program, primary);
    }

    const hasBuiltinPrimary =
      primary !== null &&
      program.commands.some(
        (command) => command.name() === primary || command.aliases().includes(primary),
      );
    const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
      argv: parseArgv,
      primary,
      hasBuiltinPrimary,
    });
    if (!shouldSkipPluginRegistration) {
      // Register plugin CLI commands before parsing
      const { registerPluginCliCommandsFromValidatedConfig } = await import("../plugins/cli.js");
      const config = await registerPluginCliCommandsFromValidatedConfig(
        program,
        undefined,
        undefined,
        {
          mode: "lazy",
          primary,
        },
      );
      if (config) {
        if (
          primary &&
          !program.commands.some(
            (command) => command.name() === primary || command.aliases().includes(primary),
          )
        ) {
          const missingPluginCommandMessage = resolveMissingPluginCommandMessage(primary, config);
          if (missingPluginCommandMessage) {
            throw new Error(missingPluginCommandMessage);
          }
        }
      }
    }

    try {
      await program.parseAsync(parseArgv);
    } catch (error) {
      if (!(error instanceof CommanderError)) {
        throw error;
      }
      process.exitCode = error.exitCode;
    }
  } finally {
    await closeCliMemoryManagers();
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
