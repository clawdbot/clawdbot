#!/usr/bin/env node
// Boots the OpenClaw CLI entry point under Node.
// CLI process entrypoint for OpenClaw command execution.
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getCommandPathWithRootOptions, hasFlag, isRootHelpInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import type { RootHelpRenderOptions } from "./cli/program/root-help.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";

const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

type PrecomputedCommandHelpName = "browser" | "secrets" | "nodes";
type OutputPrecomputedHelpText = () => boolean;

const loadRootHelpLiveConfigModule = async () => await import("./cli/root-help-live-config.js");
const loadRootHelpMetadataModule = async () => await import("./cli/root-help-metadata.js");

function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

function createGatewayEntryStartupTrace(argv: string[]) {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: entry.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Promise<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

const gatewayEntryStartupTrace = createGatewayEntryStartupTrace(process.argv);

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
  const waitingForCompileCacheRespawn = respawnWithoutOpenClawCompileCacheIfNeeded({
    currentFile: entryFile,
    installRoot,
  });
  if (!waitingForCompileCacheRespawn) {
    process.title = "openclaw";
    ensureOpenClawExecMarkerOnProcess();
    installProcessWarningFilter();
    normalizeEnv();

    enableOpenClawCompileCache({
      installRoot,
    });
    gatewayEntryStartupTrace.mark("bootstrap");

    if (shouldForceReadOnlyAuthStore(process.argv)) {
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
    }

    if (process.argv.includes("--no-color")) {
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "0";
    }

    function ensureCliRespawnReady(): boolean {
      const plan = buildCliRespawnPlan();
      if (!plan) {
        return false;
      }

      runCliRespawnPlan(plan);
      // Parent must not continue running the CLI.
      return true;
    }

    process.argv = normalizeWindowsArgv(process.argv);

    if (!ensureCliRespawnReady()) {
      const parsedContainer = parseCliContainerArgs(process.argv);
      if (!parsedContainer.ok) {
        console.error(`[openclaw] ${parsedContainer.error}`);
        process.exit(2);
      }

      const parsed = parseCliProfileArgs(parsedContainer.argv);
      if (!parsed.ok) {
        // Keep it simple; Commander will handle rich help/errors after we strip flags.
        console.error(`[openclaw] ${parsed.error}`);
        process.exit(2);
      }

      const containerTargetName = resolveCliContainerTarget(process.argv);
      if (containerTargetName && parsed.profile) {
        console.error("[openclaw] --container cannot be combined with --profile/--dev");
        process.exit(2);
      }

      if (parsed.profile) {
        applyCliProfileEnv({ profile: parsed.profile });
        // Keep Commander and ad-hoc argv checks consistent.
        process.argv = parsed.argv;
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
    onError?: (error: unknown) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  if (resolveCliContainerTarget(argv, deps.env)) {
    return false;
  }
  if (!isRootHelpInvocation(argv)) {
    return false;
  }
  const handleError =
    deps.onError ??
    ((error: unknown) => {
      console.error(
        "[openclaw] Failed to display help:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
  try {
    const loadRootHelpRenderOptionsForConfigSensitivePlugins =
      deps.loadRootHelpRenderOptionsForConfigSensitivePlugins ??
      (await loadRootHelpLiveConfigModule()).loadRootHelpRenderOptionsForConfigSensitivePlugins;
    const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(deps.env);
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
    handleError(error);
    return true;
  }
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
  if (commandName === "browser" || commandName === "secrets" || commandName === "nodes") {
    return commandName;
  }
  return null;
}

export async function tryHandlePrecomputedCommandHelpFastPath(
  argv: string[],
  deps: {
    outputPrecomputedBrowserHelpText?: OutputPrecomputedHelpText;
    outputPrecomputedSecretsHelpText?: OutputPrecomputedHelpText;
    outputPrecomputedNodesHelpText?: OutputPrecomputedHelpText;
    loadRootHelpRenderOptionsForConfigSensitivePlugins?: (
      env?: NodeJS.ProcessEnv,
    ) => Promise<RootHelpRenderOptions | null>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  if (resolveCliContainerTarget(argv, env)) {
    return false;
  }
  const commandName = resolvePrecomputedCommandHelpName(argv);
  if (!commandName) {
    return false;
  }

  try {
    if (commandName === "nodes") {
      const loadRootHelpRenderOptionsForConfigSensitivePlugins =
        deps.loadRootHelpRenderOptionsForConfigSensitivePlugins ??
        (await loadRootHelpLiveConfigModule()).loadRootHelpRenderOptionsForConfigSensitivePlugins;
      const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(env);
      if (liveRootHelpOptions) {
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
  } catch {
    return false;
  }
}

async function runMainOrRootHelp(argv: string[]): Promise<void> {
  if (await tryHandleRootHelpFastPath(argv)) {
    return;
  }
  if (await tryHandlePrecomputedCommandHelpFastPath(argv)) {
    return;
  }
  try {
    const { runCli } = await gatewayEntryStartupTrace.measure(
      "run-main-import",
      () => import("./cli/run-main.js"),
    );
    await runCli(argv);
  } catch (error) {
    const { formatCliFailureLines } = await import("./cli/failure-output.js");
    for (const line of formatCliFailureLines({
      title: "Could not start the CLI.",
      error,
      argv,
    })) {
      console.error(line);
    }
    process.exit(1);
  }
}
