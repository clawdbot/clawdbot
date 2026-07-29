// Resolves npm commands from the active Node toolchain, especially on Windows.
import fs from "node:fs";
import path from "node:path";
import {
  buildCmdExeCommandLine,
  resolvePathEnvKey,
  resolveWindowsCmdExePath,
} from "./windows-cmd-helpers.mjs";

function resolveToolchainNpmRunner(params) {
  const npmCliCandidates = [
    params.pathImpl.resolve(params.nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    params.pathImpl.resolve(params.nodeDir, "node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCliPath = npmCliCandidates.find((candidate) => params.existsSync(candidate));
  if (npmCliPath) {
    return {
      command: params.execPath,
      args: [npmCliPath, ...params.npmArgs],
      shell: false,
    };
  }
  if (params.platform !== "win32") {
    return null;
  }
  const npmExePath = params.pathImpl.resolve(params.nodeDir, "npm.exe");
  if (params.existsSync(npmExePath)) {
    return {
      command: npmExePath,
      args: params.npmArgs,
      shell: false,
    };
  }
  const npmCmdPath = params.pathImpl.resolve(params.nodeDir, "npm.cmd");
  if (params.existsSync(npmCmdPath)) {
    return {
      command: params.comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(npmCmdPath, params.npmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return null;
}

/**
 * Resolves a toolchain-local npm invocation for the current platform.
 */
export function resolveNpmRunner(params = {}) {
  const execPath = params.execPath ?? process.execPath;
  const npmArgs = params.npmArgs ?? [];
  const existsSync = params.existsSync ?? fs.existsSync;
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? (platform === "win32" ? resolveWindowsCmdExePath(env) : "");
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(execPath);
  const npmToolchain = resolveToolchainNpmRunner({
    comSpec,
    existsSync,
    execPath,
    nodeDir,
    npmArgs,
    pathImpl,
    platform,
  });
  if (npmToolchain) {
    return npmToolchain;
  }
  if (platform === "win32") {
    const expectedPaths = [
      pathImpl.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
      pathImpl.resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
      pathImpl.resolve(nodeDir, "npm.exe"),
      pathImpl.resolve(nodeDir, "npm.cmd"),
    ];
    throw new Error(
      `failed to resolve a toolchain-local npm next to ${execPath}. ` +
        `Checked: ${expectedPaths.join(", ")}. ` +
        "OpenClaw refuses to shell out to bare npm on Windows; install a Node.js toolchain that bundles npm or run with a matching Node installation.",
    );
  }
  const pathKey = resolvePathEnvKey(env);
  const currentPath = env[pathKey];
  return {
    command: "npm",
    args: npmArgs,
    shell: false,
    env: {
      ...env,
      [pathKey]:
        typeof currentPath === "string" && currentPath.length > 0
          ? `${nodeDir}${path.delimiter}${currentPath}`
          : nodeDir,
    },
  };
}
