#!/usr/bin/env node
// Routes UI package commands through the repo's Node/pnpm wrappers.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { resolveBuildIdentityEnvironment } from "./lib/build-identity.mts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { resolvePnpmRunner } from "./pnpm-runner.mts";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

const WINDOWS_CMD_EXE_EXTENSIONS = new Set([".cmd", ".bat"]);
const FORWARDED_SIGNAL_KILL_GRACE_MS = 250;

type UiBuildEnvironmentSources = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readBuildInfo?: () => unknown;
  readGitCommit?: () => string | null;
  readPackageVersion?: () => string | null;
};

function readCurrentGitCommit(): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readCurrentPackageVersion(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function readExistingBuildInfo(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "dist/build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Reuse a matching runtime identity for a standalone rebuild of the bundled UI. */
export function resolveUiBuildEnvironment(
  sources: UiBuildEnvironmentSources = {},
): NodeJS.ProcessEnv {
  const env = sources.env ?? process.env;
  const buildEnv = resolveBuildIdentityEnvironment({
    commitLabel: "Control UI build commit",
    env,
    now: sources.now,
    readGitCommit: sources.readGitCommit ?? readCurrentGitCommit,
  });
  if (env.OPENCLAW_BUILD_TIMESTAMP?.trim() || env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim()) {
    return buildEnv;
  }

  const existing = normalizeControlUiBuildInfo((sources.readBuildInfo ?? readExistingBuildInfo)());
  const version = (sources.readPackageVersion ?? readCurrentPackageVersion)();
  const release = env.OPENCLAW_CONTROL_UI_RELEASE_BUILD?.trim() === "1";
  if (
    existing.buildId === "dev" ||
    !existing.builtAt ||
    existing.commit !== buildEnv.GIT_COMMIT ||
    existing.version !== version ||
    existing.release !== release
  ) {
    return buildEnv;
  }
  return {
    ...buildEnv,
    OPENCLAW_BUILD_TIMESTAMP: existing.builtAt,
    OPENCLAW_CONTROL_UI_BUILD_ID: existing.buildId,
  };
}

type UiSpawnCall = {
  args: string[];
  command: string;
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
    stdio: "inherit";
    windowsVerbatimArguments?: boolean;
  };
};

type UiSpawnParams = {
  comSpec?: string;
  cwd?: string;
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

function usage(): void {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write("Usage: node scripts/ui.js <install|dev|build|test> [...args]\n");
}

/**
 * Returns whether Windows needs cmd.exe for a command shim.
 */
export function shouldUseCmdExeForCommand(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const extension = path.extname(cmd).toLowerCase();
  return WINDOWS_CMD_EXE_EXTENSIONS.has(extension);
}

/**
 * Builds the spawn call for a UI command, including Windows cmd.exe wrapping.
 */
export function resolveSpawnCall(
  cmd: string,
  args: string[],
  envOverride?: NodeJS.ProcessEnv,
  params: UiSpawnParams = {},
): UiSpawnCall {
  const platform = params.platform ?? process.platform;
  const options: UiSpawnCall["options"] = {
    cwd: params.cwd ?? uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
    shell: false,
  };

  if (shouldUseCmdExeForCommand(cmd, platform)) {
    const comSpec = params.comSpec ?? resolveWindowsCmdExePath(options.env);
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
export function resolvePnpmSpawnCall(
  pnpmArgs: string[],
  envOverride?: NodeJS.ProcessEnv,
  params: UiSpawnParams = {},
): UiSpawnCall {
  const env = envOverride ?? process.env;
  const platform = params.platform ?? process.platform;
  const cwd = params.cwd ?? uiDir;
  const runner = resolvePnpmRunner({
    cwd,
    env,
    pnpmArgs,
    nodeExecPath: params.nodeExecPath ?? process.execPath,
    npmExecPath: params.npmExecPath ?? env.npm_execpath,
    comSpec: params.comSpec,
    platform,
  });
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd,
      stdio: "inherit",
      env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

function runSpawnCall(spawnCall: UiSpawnCall, label: string): void {
  const { command, args: spawnArgs, options } = spawnCall;
  let child;
  try {
    child = spawn(command, spawnArgs, options);
  } catch (err) {
    console.error(`Failed to launch ${label}:`, err);
    process.exit(1);
    return;
  }

  const forwardedSignals = ["SIGTERM", "SIGHUP"] as const;
  let forwardedSignal: (typeof forwardedSignals)[number] | null = null;
  let forwardedSignalPids: number[] = [];
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let forwardedSignalDrainTimer: ReturnType<typeof setInterval> | null = null;
  const clearForwardedSignalTimers = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    if (forwardedSignalDrainTimer) {
      clearInterval(forwardedSignalDrainTimer);
      forwardedSignalDrainTimer = null;
    }
  };
  const finishForwardedSignal = () => {
    cleanupSignalHandlers();
    if (forwardedSignal) {
      process.kill(process.pid, forwardedSignal);
    }
  };
  const waitForForwardedSignalChildren = () => {
    if (!forwardedSignal || processTreeIsAlive(forwardedSignalPids)) {
      return;
    }
    finishForwardedSignal();
  };
  // Keep UI dev children in the foreground process group for native TTY
  // resize/job-control behavior. Forward wrapper shutdown signals to the
  // captured child tree instead of using a detached process group.
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [
      signal,
      () => {
        if (!forwardedSignal) {
          forwardedSignal = signal;
          forwardedSignalPids = collectChildProcessTreePids(child);
          signalProcessTree(child, signal, forwardedSignalPids);
          forwardedSignalDrainTimer = setInterval(waitForForwardedSignalChildren, 25);
          forceKillTimer = setTimeout(() => {
            signalProcessTree(child, "SIGKILL", forwardedSignalPids);
          }, FORWARDED_SIGNAL_KILL_GRACE_MS);
          forceKillTimer.unref?.();
        }
      },
    ]),
  );
  const cleanupSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    clearForwardedSignalTimers();
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
    if (forwardedSignal) {
      waitForForwardedSignalChildren();
      return;
    }
    cleanupSignalHandlers();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code !== 0) {
      process.exit(code ?? 1);
    }
  });
}

function collectChildProcessTreePids(child: ChildProcess): number[] {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return typeof child.pid === "number" ? [child.pid] : [];
  }
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0) {
    return [child.pid];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of ps.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }
  const pids = [child.pid];
  for (const parentPid of pids) {
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

function processTreeIsAlive(pids: number[]): boolean {
  return pids.some((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return hasErrorCode(error, "EPERM");
    }
  });
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals, pids: number[]): void {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  if (pids.length === 0) {
    child.kill(signal);
    return;
  }
  for (const pid of pids.toReversed()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!hasErrorCode(error, "ESRCH")) {
        throw error;
      }
    }
  }
}

function runPnpm(args: string[], envOverride?: NodeJS.ProcessEnv): void {
  runSpawnCall(resolvePnpmSpawnCall(args, envOverride), "pnpm");
}

function runSpawnCallSync(spawnCall: UiSpawnCall, label: string): void {
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

function runPnpmSync(args: string[], envOverride?: NodeJS.ProcessEnv): void {
  runSpawnCallSync(resolvePnpmSpawnCall(args, envOverride), "pnpm");
}

function depsInstalled(kind: "build" | "test"): boolean {
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

function resolveScriptAction(action: string): "dev" | "build" | "test" | null {
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

export function runUiCli(argv: string[] = process.argv.slice(2)): void {
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
  if (action === "build") {
    assertRealOutputRoot(path.join(repoRoot, "dist"));
    assertRealOutputRoot(path.join(repoRoot, "dist/control-ui"));
  }

  if (action === "install") {
    runPnpm(["install", ...rest]);
    return;
  }
  if (!script) {
    return;
  }

  const noPnpmBuild = action === "build" && process.env.OPENCLAW_BUILD_ALL_NO_PNPM === "1";
  if (!noPnpmBuild && !depsInstalled(action === "test" ? "test" : "build")) {
    const installEnv = process.env;
    const installArgs = ["install"];
    runPnpmSync(installArgs, installEnv);
  }

  if (action === "build") {
    const buildEnv = resolveUiBuildEnvironment();
    const buildCall = noPnpmBuild
      ? resolveSpawnCall(
          process.execPath,
          [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "build", ...rest],
          buildEnv,
        )
      : resolvePnpmSpawnCall(["run", "build", ...rest], buildEnv);
    runSpawnCallSync(buildCall, "Control UI build");
    if (rest.some((arg) => arg === "--help" || arg === "-h")) {
      return;
    }
    for (const [validator, ...validatorArgs] of [
      ["check-control-ui-precompressed-assets.mts"],
      ["check-control-ui-performance.mts", "--report-only"],
    ] as const) {
      runSpawnCallSync(
        resolveSpawnCall(
          process.execPath,
          [
            "--import",
            new URL("./tsx.mjs", import.meta.url).href,
            path.join(here, validator),
            ...validatorArgs,
          ],
          buildEnv,
          { cwd: repoRoot },
        ),
        validator,
      );
    }
    return;
  }

  runPnpm(["run", script, ...rest]);
}

function resolveDirectExecutionPath(
  entry: string,
  realpath: (filePath: string) => string = fs.realpathSync.native,
): string {
  const resolved = path.resolve(entry);
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

export function isDirectScriptExecution(
  entry: string | undefined = process.argv[1],
  scriptPath: string = fileURLToPath(import.meta.url),
  realpath: (filePath: string) => string = fs.realpathSync.native,
): boolean {
  if (!entry) {
    return false;
  }
  return (
    resolveDirectExecutionPath(entry, realpath) === resolveDirectExecutionPath(scriptPath, realpath)
  );
}

const isDirectExecution = isDirectScriptExecution();

if (isDirectExecution) {
  runUiCli();
}
