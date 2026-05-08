import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

function getPortableBasename(value) {
  return value.split(/[/\\]/).at(-1) ?? value;
}

function getPortableExtension(value) {
  return path.posix.extname(getPortableBasename(value)).toLowerCase();
}

function isPnpmExecPath(value) {
  return /^pnpm(?:-cli)?(?:\.(?:[cm]?js|cmd|exe))?$/.test(getPortableBasename(value).toLowerCase());
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
  const extension = getPortableExtension(value);
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
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

export function resolvePnpmRunner(params = {}) {
  const pnpmArgs = params.pnpmArgs ?? [];
  const nodeArgs = params.nodeArgs ?? [];
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? process.env.ComSpec ?? "cmd.exe";

  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isPnpmExecPath(npmExecPath)) {
    if (isNodeRunnablePnpmExecPath(npmExecPath)) {
      return {
        command: nodeExecPath,
        args: [...nodeArgs, npmExecPath, ...pnpmArgs],
        shell: false,
      };
    }

    const npmExecExtension = getPortableExtension(npmExecPath);
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

  if (platform === "win32") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine("pnpm.cmd", pnpmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: "pnpm",
    args: pnpmArgs,
    shell: false,
  };
}
