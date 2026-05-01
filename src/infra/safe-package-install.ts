import type { NpmProjectInstallEnvOptions } from "./npm-install-env.js";
import { createNpmProjectInstallEnv } from "./npm-install-env.js";

export type SafeNpmInstallEnvOptions = NpmProjectInstallEnvOptions & {
  ignoreWorkspaces?: boolean;
  legacyPeerDeps?: boolean;
  packageLock?: boolean;
  quiet?: boolean;
};

export type SafeNpmInstallArgsOptions = {
  ignoreWorkspaces?: boolean;
  loglevel?: "error" | "silent";
  noAudit?: boolean;
  noFund?: boolean;
  omitDev?: boolean;
};

export function createSafeNpmInstallEnv(
  env: NodeJS.ProcessEnv,
  options: SafeNpmInstallEnvOptions = {},
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...createNpmProjectInstallEnv(env, options),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_package_lock: options.packageLock === true ? "true" : "false",
    ...(options.ignoreWorkspaces ? { npm_config_workspaces: "false" } : {}),
    ...(options.legacyPeerDeps ? { npm_config_legacy_peer_deps: "true" } : {}),
  };
  if (options.quiet) {
    Object.assign(nextEnv, {
      npm_config_loglevel: "error",
      npm_config_progress: "false",
      npm_config_yes: "true",
    });
  }
  return nextEnv;
}

export function createSafeNpmInstallArgs(options: SafeNpmInstallArgsOptions = {}): string[] {
  return [
    "install",
    ...(options.omitDev ? ["--omit=dev"] : []),
    ...(options.loglevel ? [`--loglevel=${options.loglevel}`] : []),
    "--ignore-scripts",
    ...(options.ignoreWorkspaces ? ["--workspaces=false"] : []),
    ...(options.noAudit ? ["--no-audit"] : []),
    ...(options.noFund ? ["--no-fund"] : []),
  ];
}
