// Resolves and spawns pnpm commands portably across POSIX and Windows shells.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildCmdExeCommandLine,
  resolvePathEnvKey,
  resolveWindowsCmdExePath,
} from "./lib/windows-cmd-helpers-runtime.mts";

export type PnpmRunnerParams = {
  comSpec?: string;
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
  pnpmArgs?: string[];
  stdio?: SpawnOptions["stdio"];
};

type PnpmRunner = {
  args: string[];
  command: string;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};

function getPortableBasename(value: string) {
  return value.split(/[/\\]/).at(-1) ?? value;
}

function getPortableExtension(value: string) {
  return path.posix.extname(getPortableBasename(value)).toLowerCase();
}

function isPnpmExecPath(value: string) {
  return /^pnpm(?:-cli|-native)?(?:\.(?:[cm]?js|cmd|exe))?$/.test(
    getPortableBasename(value).toLowerCase(),
  );
}

function hasNodeShebang(value: string) {
  let fd: number | undefined;
  try {
    fd = openSync(value, "r");
    const header = Buffer.alloc(256);
    const length = readSync(fd, header, 0, header.length, 0);
    const firstLine = header.toString("utf8", 0, length).split("\n", 1)[0] ?? "";
    return /^#![ \t]*(?:\S*\/)?(?:node|env(?:[ \t]+-S)?[ \t]+node)(?:[ \t\r]|$)/u.test(firstLine);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isExecutableFile(value: string) {
  try {
    if (!statSync(value).isFile()) {
      return false;
    }
    accessSync(value, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(value: string) {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function findExecutableOnPath(
  command: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  if (typeof envPath !== "string" || envPath.length === 0) {
    return null;
  }
  const extensions =
    platform === "win32"
      ? (
          env[Object.keys(env).find((key) => key.toLowerCase() === "pathext") ?? "PATHEXT"] ??
          ".COM;.EXE;.BAT;.CMD"
        )
          .split(";")
          .filter(Boolean)
          .map((extension) => extension.toLowerCase())
      : [""];
  const pathDelimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of envPath.split(pathDelimiter)) {
    if (!directory) {
      continue;
    }
    const resolvedDirectory = path.isAbsolute(directory) ? directory : path.resolve(cwd, directory);
    for (const extension of extensions) {
      const candidate = path.join(resolvedDirectory, `${command}${extension}`);
      if (platform === "win32" ? isFile(candidate) : isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function createWindowsRunner(command: string, args: string[], comSpec: string): PnpmRunner {
  const extension = getPortableExtension(command);
  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, args)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, shell: false };
}

function isNodeRunnablePnpmExecPath(value: string) {
  if (!isPnpmExecPath(value)) {
    return false;
  }
  const extension = getPortableExtension(value);
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return isFile(value);
  }
  if (extension.length > 0) {
    return false;
  }
  return hasNodeShebang(value);
}

/**
 * Resolves the command/args needed to invoke pnpm on the current platform.
 */
export function resolvePnpmRunner(params: PnpmRunnerParams = {}): PnpmRunner {
  const pnpmArgs = params.pnpmArgs ?? [];
  const nodeArgs = params.nodeArgs ?? [];
  const env = params.env ?? process.env;
  const npmExecPath = params.npmExecPath ?? env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? (platform === "win32" ? resolveWindowsCmdExePath(env) : "");
  const envPath = env[platform === "win32" ? resolvePathEnvKey(env) : "PATH"];
  const cwd = params.cwd ?? process.cwd();

  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isPnpmExecPath(npmExecPath)) {
    if (isNodeRunnablePnpmExecPath(npmExecPath)) {
      return {
        command: nodeExecPath,
        args: [...nodeArgs, npmExecPath, ...pnpmArgs],
        shell: false,
      };
    }

    const npmExecExtension = getPortableExtension(npmExecPath);
    if (platform !== "win32" && npmExecExtension.length === 0 && isExecutableFile(npmExecPath)) {
      return {
        command: npmExecPath,
        args: pnpmArgs,
        shell: false,
      };
    }
    if (platform === "win32" && npmExecExtension === ".exe") {
      return {
        command: npmExecPath,
        args: pnpmArgs,
        shell: false,
      };
    }
    if (platform === "win32" && npmExecExtension === ".cmd") {
      return {
        command: comSpec,
        args: ["/d", "/s", "/c", buildCmdExeCommandLine(npmExecPath, pnpmArgs)],
        shell: false,
        windowsVerbatimArguments: true,
      };
    }
  }

  const pnpmPath = findExecutableOnPath("pnpm", envPath, platform, env, cwd);
  if (pnpmPath) {
    return platform === "win32"
      ? createWindowsRunner(pnpmPath, pnpmArgs, comSpec)
      : { command: pnpmPath, args: pnpmArgs, shell: false };
  }
  const corepackPath = findExecutableOnPath("corepack", envPath, platform, env, cwd);
  if (corepackPath) {
    const args = ["pnpm", ...pnpmArgs];
    return platform === "win32"
      ? createWindowsRunner(corepackPath, args, comSpec)
      : { command: corepackPath, args, shell: false };
  }

  if (platform === "win32") {
    return createWindowsRunner("pnpm.cmd", pnpmArgs, comSpec);
  }

  return {
    command: "pnpm",
    args: pnpmArgs,
    shell: false,
  };
}

/**
 * Creates a spawn-ready pnpm invocation with standard options.
 */
export function createPnpmRunnerSpawnSpec(params: PnpmRunnerParams = {}) {
  const runner = resolvePnpmRunner({ ...params, env: params.env ?? process.env });
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd: params.cwd,
      detached: params.detached,
      stdio: params.stdio ?? "inherit",
      env: params.env ?? process.env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

/**
 * Spawns a pnpm command using the portable runner resolution.
 */
export function spawnPnpmRunner(): ChildProcess;
export function spawnPnpmRunner(params: PnpmRunnerParams): ChildProcess;
export function spawnPnpmRunner(params: PnpmRunnerParams = {}) {
  const spawnSpec = createPnpmRunnerSpawnSpec(params);
  return spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
}
