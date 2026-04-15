import { spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

function isPnpmExecPath(value) {
  return /^pnpm(?:-cli)?(?:\.(?:[cm]?js|cmd|exe))?$/.test(path.basename(value).toLowerCase());
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
  const extension = path.extname(value).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return true;
  }
  if (extension.length > 0) {
    return false;
  }
  return hasScriptShebang(value);
}

export function resolvePnpmRunner(params = {}) {
  const pnpmArgs = params.pnpmArgs ?? [];
  const nodeArgs = params.nodeArgs ?? [];
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? process.env.ComSpec ?? "cmd.exe";

  if (
    typeof npmExecPath === "string" &&
    npmExecPath.length > 0 &&
    isNodeRunnablePnpmExecPath(npmExecPath)
  ) {
    return {
      command: nodeExecPath,
      args: [...nodeArgs, npmExecPath, ...pnpmArgs],
      shell: false,
    };
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

export function createPnpmRunnerSpawnSpec(params = {}) {
  const runner = resolvePnpmRunner(params);
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd: params.cwd,
      detached: params.detached,
      stdio: params.stdio ?? "inherit",
      env: params.env ?? runner.env ?? process.env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

export function spawnPnpmRunner(params = {}) {
  const spawnSpec = createPnpmRunnerSpawnSpec(params);
  return spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
}
