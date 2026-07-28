// Shared daemon install runtime/path helpers for service plan generation.
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

/** Detect source-checkout dev mode from the current CLI entrypoint. */
function resolveGatewayDevMode(argv: string[] = process.argv): boolean {
  const entry = argv[1];
  const normalizedEntry = entry?.replaceAll("\\", "/");
  return (
    normalizedEntry !== undefined &&
    normalizedEntry.includes("/src/") &&
    normalizedEntry.endsWith(".ts")
  );
}

/** Resolve dev-mode and Node path inputs for daemon service install planning. */
export async function resolveDaemonInstallRuntimeInputs(params: {
  env: Record<string, string | undefined>;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
}): Promise<{ devMode: boolean; nodePath?: string }> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  const nodePath =
    params.nodePath ??
    (await resolvePreferredNodePath({
      env: params.env,
      runtime: params.runtime,
    }));
  return { devMode, nodePath };
}

/** Emit runtime warnings for daemon install command arguments. */
export async function emitDaemonInstallRuntimeWarning(params: {
  env: Record<string, string | undefined>;
  runtime: GatewayDaemonRuntime;
  programArguments: string[];
  warn?: DaemonInstallWarnFn;
  title: string;
}): Promise<void> {
  await emitNodeRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    nodeProgram: params.programArguments[0],
    warn: params.warn,
    title: params.title,
  });
}

/** Return the Node binary directory that should be added to daemon PATH. */
export function resolveDaemonNodeBinDir(nodePath?: string): string[] | undefined {
  const trimmed = nodePath?.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  return [path.dirname(trimmed)];
}

function isOpenClawCommandBasename(basename: string, platform: NodeJS.Platform): boolean {
  if (basename === "openclaw") {
    return true;
  }
  if (platform === "win32") {
    return (
      basename === "openclaw.cmd" || basename === "openclaw.ps1" || basename === "openclaw.exe"
    );
  }
  return false;
}

function safeRealpathSync(
  inputPath: string | undefined,
  realpathSync: (path: string) => string,
): string | undefined {
  if (!inputPath) {
    return undefined;
  }
  try {
    return realpathSync(inputPath);
  } catch {
    return undefined;
  }
}

function addUniquePathDir(dirs: string[], dir: string | undefined): void {
  if (!dir || !path.isAbsolute(dir) || dirs.includes(dir)) {
    return;
  }
  dirs.push(dir);
}

/** Resolve the OpenClaw CLI binary directory from argv/PATH for daemon PATH. */
function resolveDaemonOpenClawBinDir(
  params: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    existsSync?: (path: string) => boolean;
    realpathSync?: (path: string) => string;
  } = {},
): string[] | undefined {
  const platform = params.platform ?? process.platform;
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;
  const existsSync = params.existsSync ?? fs.existsSync;
  const realpathSync = params.realpathSync ?? fs.realpathSync.native;
  const argv1 = argv[1]?.trim();
  const dirs: string[] = [];

  if (
    argv1 &&
    path.isAbsolute(argv1) &&
    isOpenClawCommandBasename(path.basename(argv1), platform)
  ) {
    addUniquePathDir(dirs, path.dirname(argv1));
  }

  const argvRealpath = path.isAbsolute(argv1 ?? "")
    ? safeRealpathSync(argv1, realpathSync)
    : undefined;
  for (const rawSegment of (env.PATH ?? "").split(path.delimiter)) {
    const segment = rawSegment.trim();
    if (!path.isAbsolute(segment)) {
      continue;
    }
    const candidate = path.join(segment, platform === "win32" ? "openclaw.cmd" : "openclaw");
    if (!existsSync(candidate)) {
      continue;
    }
    const candidateRealpath = safeRealpathSync(candidate, realpathSync);
    if (argvRealpath && candidateRealpath && candidateRealpath !== argvRealpath) {
      continue;
    }
    addUniquePathDir(dirs, segment);
  }

  return dirs.length > 0 ? dirs : undefined;
}

/** Merge Node and OpenClaw binary directories for the daemon service PATH. */
export function resolveDaemonServicePathDirs(params: {
  nodePath?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): string[] | undefined {
  const dirs: string[] = [];
  for (const dir of resolveDaemonNodeBinDir(params.nodePath) ?? []) {
    addUniquePathDir(dirs, dir);
  }
  for (const dir of resolveDaemonOpenClawBinDir(params) ?? []) {
    addUniquePathDir(dirs, dir);
  }
  return dirs.length > 0 ? dirs : undefined;
}
