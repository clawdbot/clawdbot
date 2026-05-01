import { spawnSync } from "node:child_process";

const NPM_CONFIG_KEYS_TO_RESET = new Set([
  "npm_config_global",
  "npm_config_ignore_scripts",
  "npm_config_include_workspace_root",
  "npm_config_location",
  "npm_config_prefix",
  "npm_config_workspace",
  "npm_config_workspaces",
]);

export function createNestedNpmInstallEnv(env = process.env) {
  const nextEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    if (NPM_CONFIG_KEYS_TO_RESET.has(key.toLowerCase())) {
      delete nextEnv[key];
    }
  }
  return nextEnv;
}

export function createBundledRuntimeDependencyInstallEnv(env = process.env, options = {}) {
  const nextEnv = {
    ...createNestedNpmInstallEnv(env),
    npm_config_dry_run: "false",
    npm_config_fetch_retries: env.npm_config_fetch_retries ?? "5",
    npm_config_fetch_retry_maxtimeout: env.npm_config_fetch_retry_maxtimeout ?? "120000",
    npm_config_fetch_retry_mintimeout: env.npm_config_fetch_retry_mintimeout ?? "10000",
    npm_config_fetch_timeout: env.npm_config_fetch_timeout ?? "300000",
    npm_config_ignore_scripts: "true",
    npm_config_legacy_peer_deps: "true",
    npm_config_package_lock: "false",
    npm_config_save: "false",
    npm_config_workspaces: "false",
  };
  if (options.ci) {
    nextEnv.CI = "1";
  }
  if (options.quiet) {
    Object.assign(nextEnv, {
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_loglevel: "error",
      npm_config_progress: "false",
      npm_config_yes: "true",
    });
  }
  return nextEnv;
}

export function createBundledRuntimeDependencyInstallArgs(specs = [], options = {}) {
  return [
    "install",
    ...(options.noAudit ? ["--no-audit"] : []),
    ...(options.noFund ? ["--no-fund"] : []),
    "--ignore-scripts",
    "--workspaces=false",
    ...(options.silent ? ["--silent"] : []),
    ...specs,
  ];
}

export function runBundledRuntimeDependencyNpmInstall(params) {
  const runSpawnSync = params.spawnSyncImpl ?? spawnSync;
  const result = runSpawnSync(params.npmRunner.command, params.npmRunner.args, {
    cwd: params.cwd,
    encoding: "utf8",
    env: params.env ?? params.npmRunner.env ?? process.env,
    shell: params.npmRunner.shell,
    stdio: params.stdio ?? "pipe",
    ...(params.timeoutMs ? { timeout: params.timeoutMs } : {}),
    windowsHide: true,
    windowsVerbatimArguments: params.npmRunner.windowsVerbatimArguments,
  });
  if (result.status === 0) {
    return;
  }
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  throw new Error(output || "npm install failed");
}
