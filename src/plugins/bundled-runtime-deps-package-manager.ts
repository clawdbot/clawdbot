import fs from "node:fs";
import path from "node:path";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";

export type BundledRuntimeDepsNpmRunner = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export type BundledRuntimeDepsPackageManager = "pnpm" | "npm";

export type BundledRuntimeDepsPackageManagerRunner = BundledRuntimeDepsNpmRunner & {
  packageManager: BundledRuntimeDepsPackageManager;
};

const NPM_EXECPATH_ENV_KEY = "npm_execpath";

export function createBundledRuntimeDepsInstallEnv(
  env: NodeJS.ProcessEnv,
  options: { cacheDir?: string } = {},
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...createSafeNpmInstallEnv(env, {
      ...options,
      ignoreWorkspaces: true,
      legacyPeerDeps: true,
      packageLock: true,
    }),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase() === NPM_EXECPATH_ENV_KEY) {
      delete nextEnv[key];
    }
  }
  return nextEnv;
}

export function createBundledRuntimeDepsInstallArgs(): string[] {
  return createSafeNpmInstallArgs({
    ignoreWorkspaces: true,
    noAudit: true,
    noFund: true,
    omitDev: true,
  });
}

function createBundledRuntimeDepsPnpmInstallArgs(params: { storeDir: string }): string[] {
  return [
    "install",
    "--prod",
    "--ignore-scripts",
    "--ignore-workspace",
    "--config.frozen-lockfile=false",
    "--config.minimum-release-age=0",
    `--config.store-dir=${params.storeDir}`,
    "--config.node-linker=hoisted",
    "--config.virtual-store-dir=.pnpm",
  ];
}

export function resolveBundledRuntimeDepsNpmRunner(params: {
  npmArgs: string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
}): BundledRuntimeDepsNpmRunner {
  const execPath = params.execPath ?? process.execPath;
  const existsSync = params.existsSync ?? fs.existsSync;
  const platform = params.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(execPath);

  const npmCliCandidates = [
    pathImpl.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    pathImpl.resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCliPath = npmCliCandidates.find(
    (candidate) => pathImpl.isAbsolute(candidate) && existsSync(candidate),
  );
  if (npmCliPath) {
    return {
      command: execPath,
      args: [npmCliPath, ...params.npmArgs],
    };
  }

  if (platform === "win32") {
    const npmExePath = pathImpl.resolve(nodeDir, "npm.exe");
    if (existsSync(npmExePath)) {
      return {
        command: npmExePath,
        args: params.npmArgs,
      };
    }
    throw new Error("Unable to resolve a safe npm executable on Windows");
  }

  const npmExePath = pathImpl.resolve(nodeDir, "npm");
  if (existsSync(npmExePath)) {
    return {
      command: npmExePath,
      args: params.npmArgs,
    };
  }

  throw new Error("Unable to resolve a safe npm executable");
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return (env[pathKey] ?? "")
    .split(platform === "win32" ? ";" : path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function resolveBundledRuntimeDepsPnpmRunner(params: {
  pnpmArgs: string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
}): BundledRuntimeDepsPackageManagerRunner | null {
  const env = params.env ?? process.env;
  const execPath = params.execPath ?? process.execPath;
  const existsSync = params.existsSync ?? fs.existsSync;
  const platform = params.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(execPath);
  const names = platform === "win32" ? ["pnpm.exe"] : ["pnpm"];
  const candidateDirs = [nodeDir, ...pathEntries(env, platform)];
  for (const dir of candidateDirs) {
    for (const name of names) {
      const candidate = pathImpl.resolve(dir, name);
      if (pathImpl.isAbsolute(candidate) && existsSync(candidate)) {
        return {
          packageManager: "pnpm",
          command: candidate,
          args: params.pnpmArgs,
        };
      }
    }
  }
  return null;
}

export function resolveBundledRuntimeDepsPackageManagerRunner(params: {
  installExecutionRoot: string;
  env: NodeJS.ProcessEnv;
  npmArgs: string[];
}): BundledRuntimeDepsPackageManagerRunner {
  const pnpmRunner = resolveBundledRuntimeDepsPnpmRunner({
    env: params.env,
    pnpmArgs: createBundledRuntimeDepsPnpmInstallArgs({
      storeDir: path.join(params.installExecutionRoot, ".openclaw-pnpm-store"),
    }),
  });
  if (pnpmRunner) {
    return pnpmRunner;
  }
  return {
    packageManager: "npm",
    ...resolveBundledRuntimeDepsNpmRunner({
      env: params.env,
      npmArgs: params.npmArgs,
    }),
  };
}
