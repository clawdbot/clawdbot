#!/usr/bin/env node
// Routes UI package commands through the repo's Node/pnpm wrappers.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

const WINDOWS_CMD_EXE_EXTENSIONS = new Set([".cmd", ".bat"]);

function usage() {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write("Usage: node scripts/ui.js <install|dev|build|test> [...args]\n");
}

/**
 * Returns whether Windows needs cmd.exe for a command shim.
 */
export function shouldUseCmdExeForCommand(cmd, platform = process.platform) {
  if (platform !== "win32") {
    return false;
  }
  const extension = path.extname(cmd).toLowerCase();
  return WINDOWS_CMD_EXE_EXTENSIONS.has(extension);
}

/**
 * Builds the spawn call for a UI command, including Windows cmd.exe wrapping.
 */
export function resolveSpawnCall(cmd, args, envOverride, params = {}) {
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? process.env.ComSpec ?? "cmd.exe";
  const options = {
    cwd: params.cwd ?? uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
    shell: false,
  };

  if (shouldUseCmdExeForCommand(cmd, platform)) {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(cmd, args)],
      options: {
        ...options,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    command: cmd,
    args,
    options,
  };
}

/**
 * Builds the pnpm-backed spawn call for UI package scripts.
 */
export function resolvePnpmSpawnCall(pnpmArgs, envOverride, params = {}) {
  const env = envOverride ?? process.env;
  const platform = params.platform ?? process.platform;
  const runner = resolvePnpmRunner({
    pnpmArgs,
    nodeExecPath: params.nodeExecPath ?? process.execPath,
    npmExecPath: params.npmExecPath ?? env.npm_execpath,
    comSpec: params.comSpec ?? env.ComSpec,
    platform,
  });
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd: params.cwd ?? uiDir,
      stdio: "inherit",
      env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

function runSpawnCall(spawnCall, label) {
  const { command, args: spawnArgs, options } = spawnCall;
  let child;
  try {
    child = spawn(command, spawnArgs, options);
  } catch (err) {
    console.error(`Failed to launch ${label}:`, err);
    process.exit(1);
    return;
  }

  let forwardedSignal = null;
  let forceKillTimer = null;
  // Keep UI dev children in the foreground process group for native TTY
  // resize/job-control behavior. Forward direct wrapper shutdown signals.
  const forwardedSignals = ["SIGTERM", "SIGHUP"];
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [
      signal,
      () => {
        forwardedSignal ??= signal;
        child.kill(signal);
        forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
      },
    ]),
  );
  const cleanupSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
  };
  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  child.on("error", (err) => {
    cleanupSignalHandlers();
    console.error(`Failed to launch ${label}:`, err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    cleanupSignalHandlers();
    if (forwardedSignal) {
      process.kill(process.pid, forwardedSignal);
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code !== 0) {
      process.exit(code ?? 1);
    }
  });
}

function run(cmd, args) {
  runSpawnCall(resolveSpawnCall(cmd, args), cmd);
}

function runPnpm(args, envOverride) {
  runSpawnCall(resolvePnpmSpawnCall(args, envOverride), "pnpm");
}

function runSpawnCallSync(spawnCall, label) {
  const { command, args: spawnArgs, options } = spawnCall;
  let result;
  try {
    result = spawnSync(command, spawnArgs, options);
  } catch (err) {
    console.error(`Failed to launch ${label}:`, err);
    process.exit(1);
    return;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runPnpmSync(args, envOverride) {
  runSpawnCallSync(resolvePnpmSpawnCall(args, envOverride), "pnpm");
}

function depsInstalled(kind) {
  try {
    const require = createRequire(path.join(uiDir, "package.json"));
    require.resolve("vite");
    require.resolve("dompurify");
    if (kind === "test") {
      require.resolve("vitest");
      require.resolve("@vitest/browser-playwright");
      require.resolve("playwright");
    }
    return true;
  } catch {
    return false;
  }
}

function resolveScriptAction(action) {
  if (action === "install") {
    return null;
  }
  if (action === "dev") {
    return "dev";
  }
  if (action === "build") {
    return "build";
  }
  if (action === "test") {
    return "test";
  }
  return null;
}

export function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  if (!action) {
    usage();
    process.exit(2);
  }

  const script = resolveScriptAction(action);
  if (action !== "install" && !script) {
    usage();
    process.exit(2);
  }

  if (process.env.OPENCLAW_BUILD_ALL_NO_PNPM === "1" && action === "build") {
    run(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "build", ...rest]);
    return;
  }

  if (action === "install") {
    runPnpm(["install", ...rest]);
    return;
  }

  if (!depsInstalled(action === "test" ? "test" : "build")) {
    const installEnv = process.env;
    const installArgs = ["install"];
    runPnpmSync(installArgs, installEnv);
  }

  runPnpm(["run", script, ...rest]);
}

export function resolveDirectExecutionPath(entry, realpath = fs.realpathSync.native) {
  const resolved = path.resolve(entry);
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

export function isDirectScriptExecution(
  entry = process.argv[1],
  scriptPath = fileURLToPath(import.meta.url),
  realpath = fs.realpathSync.native,
) {
  if (!entry) {
    return false;
  }
  return (
    resolveDirectExecutionPath(entry, realpath) === resolveDirectExecutionPath(scriptPath, realpath)
  );
}

const isDirectExecution = isDirectScriptExecution();

if (isDirectExecution) {
  main();
}
