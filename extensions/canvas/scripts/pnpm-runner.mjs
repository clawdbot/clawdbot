/**
 * Cross-platform pnpm command resolver used by Canvas build scripts.
 */
import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;
const PNPM_EXECUTABLE_RE = /^pnpm(?:-cli)?(?:\.(?:[cm]?js|cmd|exe))?$/;
const NODE_RUNNABLE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

function inspectExecutablePath(value) {
  const basename = value.split(/[/\\]/).at(-1) ?? value;
  const extension = basename.match(/(\.[^.]+)$/u)?.[1]?.toLowerCase() ?? "";
  return { basename: basename.toLowerCase(), extension };
}

function isPnpmExecPath(value) {
  return PNPM_EXECUTABLE_RE.test(inspectExecutablePath(value).basename);
}

function hasScriptShebang(value) {
  let fd;
  try {
    fd = openSync(value, "r");
    const header = Buffer.alloc(2);
    return (
      readSync(fd, header, 0, header.length, 0) === header.length &&
      header[0] === 0x23 &&
      header[1] === 0x21
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isExecutableFile(value) {
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

function isFile(value) {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function findExecutableOnPath(command, envPath, platform, env, cwd) {
  if (typeof envPath !== "string" || envPath.length === 0) {
    return undefined;
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
  const pathImpl = platform === "win32" ? path.win32 : path;
  const pathDelimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of envPath.split(pathDelimiter)) {
    if (!directory) {
      continue;
    }
    const resolvedDirectory = pathImpl.isAbsolute(directory)
      ? directory
      : pathImpl.resolve(cwd, directory);
    for (const extension of extensions) {
      const candidate = pathImpl.join(resolvedDirectory, `${command}${extension}`);
      if (platform === "win32" ? isFile(candidate) : isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isNodeRunnablePnpmExecPath(value) {
  if (!isPnpmExecPath(value)) {
    return false;
  }
  const { extension } = inspectExecutablePath(value);
  if (NODE_RUNNABLE_EXTENSIONS.has(extension)) {
    return isFile(value);
  }
  if (extension.length > 0) {
    return false;
  }
  return hasScriptShebang(value);
}

function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

function buildCmdExeCommandLine(command, args) {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
}

function windowsCmdSpec(command, args, comSpec) {
  return {
    args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, args)],
    command: comSpec,
    shell: false,
    windowsVerbatimArguments: true,
  };
}

function resolveConfiguredPnpmExec(params) {
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0 || !isPnpmExecPath(npmExecPath)) {
    return undefined;
  }

  if (isNodeRunnablePnpmExecPath(npmExecPath)) {
    return {
      args: [...(params.nodeArgs ?? []), npmExecPath, ...(params.pnpmArgs ?? [])],
      command: params.nodeExecPath ?? process.execPath,
      shell: false,
    };
  }

  const { extension } = inspectExecutablePath(npmExecPath);
  if ((params.platform ?? process.platform) !== "win32") {
    return extension.length === 0 && isExecutableFile(npmExecPath)
      ? { args: params.pnpmArgs ?? [], command: npmExecPath, shell: false }
      : undefined;
  }

  if (extension === ".exe") {
    return { args: params.pnpmArgs ?? [], command: npmExecPath, shell: false };
  }
  if (extension === ".cmd") {
    return windowsCmdSpec(
      npmExecPath,
      params.pnpmArgs ?? [],
      params.comSpec ?? process.env.ComSpec ?? "cmd.exe",
    );
  }
  return undefined;
}

/** Resolves a safe pnpm command spec for Unix, Windows, and npm_execpath launches. */
export function resolvePnpmRunner(params = {}) {
  const configured = resolveConfiguredPnpmExec(params);
  if (configured) {
    return configured;
  }

  const pnpmArgs = params.pnpmArgs ?? [];
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const envPath = env[platform === "win32" ? resolvePathEnvKey(env) : "PATH"];
  const cwd = params.cwd ?? process.cwd();
  const pnpmPath = findExecutableOnPath("pnpm", envPath, platform, env, cwd);
  if (pnpmPath) {
    return platform === "win32"
      ? windowsCmdSpec(pnpmPath, pnpmArgs, params.comSpec ?? process.env.ComSpec ?? "cmd.exe")
      : { args: pnpmArgs, command: pnpmPath, shell: false };
  }
  const corepackPath = findExecutableOnPath("corepack", envPath, platform, env, cwd);
  if (corepackPath) {
    const args = ["pnpm", ...pnpmArgs];
    return platform === "win32"
      ? windowsCmdSpec(corepackPath, args, params.comSpec ?? process.env.ComSpec ?? "cmd.exe")
      : { args, command: corepackPath, shell: false };
  }
  if (platform === "win32") {
    return windowsCmdSpec("pnpm.cmd", pnpmArgs, params.comSpec ?? process.env.ComSpec ?? "cmd.exe");
  }

  return { args: pnpmArgs, command: "pnpm", shell: false };
}
