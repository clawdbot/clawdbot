#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";
import { buildCliRespawnPlan } from "./entry.respawn.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

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

      const child = spawn(plan.command, plan.argv, {
        stdio: "inherit",
        env: plan.env,
      });

      attachChildProcessBridge(child);

      child.once("exit", (code, signal) => {
        if (signal) {
          process.exitCode = 1;
          return;
        }
        process.exit(code ?? 1);
      });

      child.once("error", (error) => {
        console.error(
          "[openclaw] Failed to respawn CLI:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        process.exit(1);
      });

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
    outputRootHelp?: () => void | Promise<void>;
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
    if (deps.outputRootHelp) {
      await deps.outputRootHelp();
      return true;
    }
    const outputPrecomputedRootHelpText =
      deps.outputPrecomputedRootHelpText ??
      (await import("./cli/root-help-metadata.js")).outputPrecomputedRootHelpText;
    if (!outputPrecomputedRootHelpText()) {
      const { outputRootHelp } = await import("./cli/program/root-help.js");
      await outputRootHelp();
    }
    return true;
  } catch (error) {
    handleError(error);
    return true;
  }
}

async function runMainOrRootHelp(argv: string[]): Promise<void> {
  if (await tryHandleRootHelpFastPath(argv)) {
    return;
  }
  try {
    const { runCli } = await gatewayEntryStartupTrace.measure(
      "run-main-import",
      () => import("./cli/run-main.js"),
    );
    await runCli(argv);
  } catch (error) {
    console.error(
      "[openclaw] Failed to start CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  }
}
