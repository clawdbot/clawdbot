#!/usr/bin/env node
// Boots the OpenClaw CLI entry point under Node.
// CLI process entrypoint for OpenClaw command execution.
import process from "node:process";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { isRootHelpInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from "./cli/one-shot-exit.js";
import {
  tryOutputPrecomputedCommandHelp,
  type PrecomputedCommandHelpDeps,
} from "./cli/precomputed-help.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import type { RootHelpRenderOptions } from "./cli/program/root-help.js";
import { isNativeHookRelayArgv } from "./cli/respawn-policy.js";
import {
  configureGatewayStartupTraceConsoleFormatting,
  createGatewayStartupTrace,
} from "./cli/startup-trace.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { defaultRuntime } from "./runtime.js";

const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

const loadRootHelpLiveConfigModule = async () => await import("./cli/root-help-live-config.js");
const loadRootHelpMetadataModule = async () => await import("./cli/root-help-metadata.js");

async function writeCapturedCliArgumentError(message: string): Promise<void> {
  const { loadCliDotEnv } = await import("./cli/dotenv.js");
  loadCliDotEnv({ quiet: true });
  await configureGatewayStartupTraceConsoleFormatting(gatewayEntryStartupTrace);
  const { enableConsoleCapture } = await import("./logging.js");
  enableConsoleCapture();
  console.error(`[openclaw] ${message}`);
}

async function writeCliDiagnosticBlock(message: string): Promise<void> {
  const { loadCliDotEnv } = await import("./cli/dotenv.js");
  loadCliDotEnv({ quiet: true });
  await configureGatewayStartupTraceConsoleFormatting(gatewayEntryStartupTrace);
  const { formatConsoleDiagnosticBlock } = await import("./logging/json-console-line.js");
  process.stderr.write(formatConsoleDiagnosticBlock({ level: "error", message: `${message}\n` }));
}

async function prepareCliDiagnosticBlockWriter(): Promise<
  (message: string, error?: unknown) => void
> {
  const { loadCliDotEnv } = await import("./cli/dotenv.js");
  loadCliDotEnv({ quiet: true });
  await configureGatewayStartupTraceConsoleFormatting(gatewayEntryStartupTrace);
  const { formatConsoleDiagnosticBlock } = await import("./logging/json-console-line.js");
  return (message, error) => {
    const formatted = error === undefined ? message : format(message, error);
    process.stderr.write(
      formatConsoleDiagnosticBlock({
        level: "error",
        message: formatted.endsWith("\n") ? formatted : `${formatted}\n`,
      }),
    );
  };
}

async function flushEntryStartupTraceForEarlyReturn(argv: string[]): Promise<void> {
  if (!gatewayEntryStartupTrace.enabled) {
    return;
  }
  const { loadCliDotEnvForEarlyDiagnostic } = await import("./cli/dotenv.js");
  await loadCliDotEnvForEarlyDiagnostic(argv);
  await configureGatewayStartupTraceConsoleFormatting(gatewayEntryStartupTrace);
}

function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

const gatewayEntryStartupTrace = createGatewayStartupTrace(process.argv, "entry");

// Guard: only run entry-point logic when this file is the main module.
// The bundler may import entry.js as a shared dependency when dist/index.js
// is the actual entry point; without this guard the top-level code below
// would call runCli a second time, starting a duplicate gateway that fails
// on the lock / port and crashes the process.
if (
  !isMainModule({
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  // Imported as a dependency — skip all entry-point side effects.
} else {
  const entryFile = fileURLToPath(import.meta.url);
  const installRoot = resolveEntryInstallRoot(entryFile);
  process.title = "openclaw";
  ensureOpenClawExecMarkerOnProcess();
  installProcessWarningFilter();
  normalizeEnv();
  process.argv = normalizeWindowsArgv(process.argv);
  const earlyProfile = parseCliProfileArgs(process.argv);
  if (earlyProfile.ok && earlyProfile.profile) {
    applyCliProfileEnv({ profile: earlyProfile.profile });
  }
  const { assertSupportedRuntime, isCurrentRuntimeSupported } =
    await import("./infra/runtime-guard.js");
  if (!isCurrentRuntimeSupported()) {
    const { loadCliDotEnv } = await import("./cli/dotenv.js");
    loadCliDotEnv({ quiet: true });
    await configureGatewayStartupTraceConsoleFormatting(gatewayEntryStartupTrace);
  }
  assertSupportedRuntime();
  gatewayEntryStartupTrace.mark("bootstrap");

  const waitingForCompileCacheRespawn = await respawnWithoutOpenClawCompileCacheIfNeeded({
    currentFile: entryFile,
    installRoot,
    prepareWriteError: async () => {
      // The child environment was already snapshotted. Load dotenv only to format
      // the parent trace; command-specific dotenv ordering remains child-owned.
      const writeError = await prepareCliDiagnosticBlockWriter();
      return (message) => writeError(message);
    },
  });
  if (!waitingForCompileCacheRespawn) {
    enableOpenClawCompileCache({
      installRoot,
    });

    if (shouldForceReadOnlyAuthStore(process.argv)) {
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
    }

    if (process.argv.includes("--no-color")) {
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "0";
    }

    async function ensureCliRespawnReady(): Promise<boolean> {
      const plan = buildCliRespawnPlan();
      if (!plan) {
        return false;
      }

      // The child environment was already snapshotted. Load dotenv only to format
      // the parent trace; command-specific dotenv ordering remains child-owned.
      const writeError = await prepareCliDiagnosticBlockWriter();
      runCliRespawnPlan(plan, undefined, writeError);
      // Parent must not continue running the CLI.
      return true;
    }

    if (!(await ensureCliRespawnReady())) {
      const parsedContainer = parseCliContainerArgs(process.argv);
      if (!parsedContainer.ok) {
        await writeCapturedCliArgumentError(parsedContainer.error);
        process.exit(2);
      }

      const parsed = parseCliProfileArgs(parsedContainer.argv);
      if (!parsed.ok) {
        // Keep it simple; Commander will handle rich help/errors after we strip flags.
        await writeCapturedCliArgumentError(parsed.error);
        process.exit(2);
      }

      const containerTargetName = resolveCliContainerTarget(process.argv);
      if (parsed.profile) {
        applyCliProfileEnv({ profile: parsed.profile });
        // Keep Commander and ad-hoc argv checks consistent.
        process.argv = parsed.argv;
      }
      if (containerTargetName && parsed.profile) {
        await writeCapturedCliArgumentError("--container cannot be combined with --profile/--dev");
        process.exit(2);
      }
      gatewayEntryStartupTrace.mark("argv");

      if (!tryHandleRootVersionFastPath(process.argv)) {
        await runMainOrRootHelp(process.argv);
      }
    }
  }
}

export async function tryHandleRootHelpFastPath(
  argv: string[],
  deps: {
    outputPrecomputedRootHelpText?: () => boolean;
    outputRootHelp?: (options?: RootHelpRenderOptions) => void | Promise<void>;
    loadRootHelpRenderOptionsForConfigSensitivePlugins?: (
      env?: NodeJS.ProcessEnv,
    ) => Promise<RootHelpRenderOptions | null>;
    onError?: (error: unknown) => void | Promise<void>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (
    env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1" ||
    resolveCliContainerTarget(argv, env)
  ) {
    return false;
  }
  if (!isRootHelpInvocation(argv)) {
    return false;
  }
  const handleError =
    deps.onError ??
    (async (error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      await writeCliDiagnosticBlock(`[openclaw] Failed to display help: ${detail}`);
      process.exit(1);
    });
  try {
    const loadRootHelpRenderOptionsForConfigSensitivePlugins =
      deps.loadRootHelpRenderOptionsForConfigSensitivePlugins ??
      (await loadRootHelpLiveConfigModule()).loadRootHelpRenderOptionsForConfigSensitivePlugins;
    const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(env);
    if (!liveRootHelpOptions) {
      const outputPrecomputedRootHelpText =
        deps.outputPrecomputedRootHelpText ??
        (await loadRootHelpMetadataModule()).outputPrecomputedRootHelpText;
      if (outputPrecomputedRootHelpText()) {
        return true;
      }
    }
    const outputRootHelp =
      deps.outputRootHelp ?? (await import("./cli/program/root-help.js")).outputRootHelp;
    await outputRootHelp(liveRootHelpOptions ?? undefined);
    return true;
  } catch (error) {
    await handleError(error);
    return true;
  }
}

export async function tryHandlePrecomputedCommandHelpFastPath(
  argv: string[],
  deps: PrecomputedCommandHelpDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (resolveCliContainerTarget(argv, env)) {
    return false;
  }

  try {
    return await tryOutputPrecomputedCommandHelp(argv, { ...deps, env });
  } catch {
    return false;
  }
}

export async function runMainOrRootHelp(
  argv: string[],
  deps: RunMainOrRootHelpDeps = {},
): Promise<void> {
  await runCliWithExitFinalization({
    run: async () => {
      if (isNativeHookRelayArgv(argv) && !argv.includes("--help") && !argv.includes("-h")) {
        const { runNativeHookRelayCliFromArgv } = await import("./cli/native-hook-relay-cli.js");
        const exitCode = await runNativeHookRelayCliFromArgv(argv);
        process.exitCode = exitCode;
        requestExitAfterOneShotOutput(defaultRuntime, exitCode);
        return;
      }
      if (await tryHandleRootHelpFastPath(argv)) {
        await flushEntryStartupTraceForEarlyReturn(argv);
        return;
      }
      if (await tryHandlePrecomputedCommandHelpFastPath(argv)) {
        await flushEntryStartupTraceForEarlyReturn(argv);
        return;
      }
      const { runCli } = await gatewayEntryStartupTrace.measure(
        "run-main-import",
        deps.loadRunCli ?? (() => import("./cli/run-main.js")),
      );
      await runCli(argv, {
        additionalStartupTrace: gatewayEntryStartupTrace,
        // Finalizers and process-exit hooks can still emit diagnostics after runCli settles.
        retainConsoleRoutingUntilProcessExit: true,
      });
    },
    onError: async (error) => {
      const { loadCliDotEnvForEarlyDiagnostic } = await import("./cli/dotenv.js");
      await loadCliDotEnvForEarlyDiagnostic(argv);
      await configureGatewayStartupTraceConsoleFormatting(gatewayEntryStartupTrace);
      const { enableConsoleCapture } = await import("./logging.js");
      enableConsoleCapture();
      const { formatCliFailureLines } = await import("./cli/failure-output.js");
      for (const line of formatCliFailureLines({
        title: "Could not start the CLI.",
        error,
        argv,
      })) {
        console.error(line);
      }
      process.exitCode = 1;
    },
  });
}

type RunMainOrRootHelpDeps = {
  loadRunCli?: () => Promise<Pick<typeof import("./cli/run-main.js"), "runCli">>;
};
