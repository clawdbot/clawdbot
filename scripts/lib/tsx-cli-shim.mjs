// Bootstraps documented JavaScript entrypoints before the TypeScript loader is active.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureRepoNodeModulesLink } from "./local-check-runtime.mts";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const DEFAULT_FORCE_KILL_DELAY_MS = 5_000;
const SHIM_CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePrimaryRoot(checkoutRoot) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: checkoutRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    return null;
  }
  const resolved = path.resolve(checkoutRoot, commonDir);
  return path.basename(resolved) === ".git" ? path.dirname(resolved) : null;
}

function resolveTsxImport(checkoutRoot) {
  const modulesDir =
    process.env.PNPM_CONFIG_MODULES_DIR?.trim() || process.env.npm_config_modules_dir?.trim();
  const hydratedTsxRoot = modulesDir
    ? path.join(path.resolve(checkoutRoot, modulesDir), "tsx")
    : null;
  let resolutionError;
  for (const candidateRoot of [
    hydratedTsxRoot,
    checkoutRoot,
    resolvePrimaryRoot(checkoutRoot),
  ].filter(Boolean)) {
    try {
      const require = createRequire(path.join(candidateRoot, "package.json"));
      const importUrl = pathToFileURL(require.resolve("tsx")).href;
      const selectedModulesDir =
        candidateRoot === hydratedTsxRoot
          ? path.dirname(candidateRoot)
          : path.join(candidateRoot, "node_modules");
      ensureRepoNodeModulesLink(selectedModulesDir, { cwd: checkoutRoot });
      return importUrl;
    } catch (error) {
      resolutionError = error;
    }
  }
  throw resolutionError;
}

export async function registerToolingTsx() {
  // tsx indexes the entire shared disk cache before expiration, coupling startup
  // to other checkouts' cache size. This flag retains its in-process Map and
  // reaches descendant tooling before their loaders initialize.
  process.env.TSX_DISABLE_CACHE = "1";
  await import(resolveTsxImport(SHIM_CHECKOUT_ROOT));
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function writeFailureTrailer(tool, exitCode) {
  if (tool && exitCode !== 0) {
    console.error(`[${tool}] FAILED (exit ${exitCode})`);
  }
}

function signalChild(child, signal, detached) {
  if (!child?.pid) {
    return;
  }
  try {
    if (detached && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      console.error(error);
    }
  }
}

async function runTsxCliShimInner(moduleUrl, options) {
  const detached = options.detached ?? (process.platform !== "win32" && !process.stdin.isTTY);
  const forceKillDelayMs = options.forceKillDelayMs ?? DEFAULT_FORCE_KILL_DELAY_MS;
  let child = null;
  let forceKillTimer = null;
  const signalHandlers = new Map();
  const cleanup = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    process.off("exit", exitHandler);
  };
  const exitHandler = () => signalChild(child, "SIGTERM", detached);

  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      signalChild(child, signal, detached);
      forceKillTimer ??= setTimeout(
        () => signalChild(child, "SIGKILL", detached),
        forceKillDelayMs,
      );
      forceKillTimer.unref();
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  process.on("exit", exitHandler);

  try {
    const implementationUrl = new URL(options.implementation, moduleUrl);
    const implementationPath = fileURLToPath(implementationUrl);
    const tsxImport = new URL("../tsx.mjs", import.meta.url).href;
    const nodeExecutable = process.versions.bun ? "node" : process.execPath;
    child = spawn(
      nodeExecutable,
      ["--import", tsxImport, implementationPath, ...process.argv.slice(2)],
      {
        cwd: process.cwd(),
        detached,
        env: process.env,
        stdio: "inherit",
      },
    );
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    cleanup();

    if (result.signal) {
      writeFailureTrailer(options.failureTool, signalExitCode(result.signal));
      process.kill(process.pid, result.signal);
      return;
    }
    const exitCode = result.code ?? 1;
    writeFailureTrailer(options.failureTool, exitCode);
    process.exitCode = exitCode;
  } catch (error) {
    cleanup();
    console.error(error);
    writeFailureTrailer(options.failureTool, 1);
    process.exitCode = 1;
  }
}

export async function runTsxCliShim(moduleUrl, options = {}) {
  try {
    await runTsxCliShimInner(moduleUrl, options);
  } catch (error) {
    console.error(error);
    writeFailureTrailer(options.failureTool, 1);
    process.exitCode = 1;
  }
}
