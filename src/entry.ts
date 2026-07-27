#!/usr/bin/env node
// Boots the OpenClaw CLI entry point under Node.
// CLI process entrypoint for OpenClaw command execution.
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { runCliWithExitFinalization } from "./cli/one-shot-exit.js";
import {
  tryOutputPrecomputedCommandHelp,
  type PrecomputedCommandHelpDeps,
} from "./cli/precomputed-help.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import type { RootHelpRenderOptions } from "./cli/program/root-help.js";
import { createGatewayStartupTrace } from "./cli/startup-trace.js";
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

const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

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
  const waitingForCompileCacheRespawn = respawnWithoutOpenClawCompileCacheIfNeeded({
    currentFile: entryFile,
    installRoot,
  });
  if (!waitingForCompileCacheRespawn) {
    process.title = "openclaw";
    ensureOpenClawExecMarkerOnProcess();
    installProcessWarningFilter();
    normalizeEnv();
    const { assertSupportedRuntime } = await import("./infra/runtime-guard.js");
    assertSupportedRuntime();

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
      process.exit(1);
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

async function runMainOrRootHelp(argv: string[]): Promise<void> {
  await runCliWithExitFinalization({
    run: async () => {
      if (await tryHandleRootHelpFastPath(argv)) {
        return;
      }
      if (await tryHandlePrecomputedCommandHelpFastPath(argv)) {
        return;
      }
      const { runCli } = await gatewayEntryStartupTrace.measure(
        "run-main-import",
        () => import("./cli/run-main.js"),
      );
      await runCli(argv);
    },
    onError: async (error) => {
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
