import { closeSync, openSync, readSync } from "node:fs";

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

function isNodeRunnablePnpmExecPath(value) {
  if (!isPnpmExecPath(value)) {
    return false;
  }
  const { extension } = inspectExecutablePath(value);
  if (NODE_RUNNABLE_EXTENSIONS.has(extension)) {
    return true;
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

  if ((params.platform ?? process.platform) !== "win32") {
    return undefined;
  }

  const { extension } = inspectExecutablePath(npmExecPath);
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

export function resolvePnpmRunner(params = {}) {
  const configured = resolveConfiguredPnpmExec(params);
  if (configured) {
    return configured;
  }

  const pnpmArgs = params.pnpmArgs ?? [];
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    return windowsCmdSpec("pnpm.cmd", pnpmArgs, params.comSpec ?? process.env.ComSpec ?? "cmd.exe");
  }

  return { args: pnpmArgs, command: "pnpm", shell: false };
}
