import fsSync from "node:fs";
import path from "node:path";

export type NpmProjectInstallEnvOptions = {
  cacheDir?: string;
};

const NPM_CONFIG_SCRIPT_SHELL_KEYS = ["NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell"];

const NPM_CONFIG_KEYS_TO_RESET = new Set([
  "npm_config_cache",
  "npm_config_dry_run",
  "npm_config_global",
  "npm_config_include_workspace_root",
  "npm_config_ignore_scripts",
  "npm_config_location",
  "npm_config_legacy_peer_deps",
  "npm_config_prefix",
  "npm_config_strict_peer_deps",
  "npm_config_workspace",
  "npm_config_workspaces",
]);

export function createNpmProjectInstallEnv(
  env: NodeJS.ProcessEnv,
  options: NpmProjectInstallEnvOptions = {},
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    if (NPM_CONFIG_KEYS_TO_RESET.has(key.toLowerCase())) {
      delete nextEnv[key];
    }
  }
  const installEnv: NodeJS.ProcessEnv = {
    ...nextEnv,
    npm_config_dry_run: "false",
    npm_config_fetch_retries: nextEnv.npm_config_fetch_retries ?? "5",
    npm_config_fetch_retry_maxtimeout: nextEnv.npm_config_fetch_retry_maxtimeout ?? "120000",
    npm_config_fetch_retry_mintimeout: nextEnv.npm_config_fetch_retry_mintimeout ?? "10000",
    npm_config_fetch_timeout: nextEnv.npm_config_fetch_timeout ?? "300000",
    npm_config_global: "false",
    npm_config_location: "project",
    npm_config_package_lock: "false",
    npm_config_save: "false",
    ...(options.cacheDir ? { npm_config_cache: options.cacheDir } : {}),
  };
  applyPosixNpmScriptShellEnv(installEnv);
  return installEnv;
}

export function hasNpmScriptShellSetting(env: NodeJS.ProcessEnv): boolean {
  return NPM_CONFIG_SCRIPT_SHELL_KEYS.some((key) => Boolean(env[key]?.trim()));
}

export function resolvePosixNpmScriptShell(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === "win32") {
    return null;
  }
  if (fsSync.existsSync("/bin/sh")) {
    return "/bin/sh";
  }
  const shell = env.SHELL?.trim();
  return shell && path.isAbsolute(shell) && fsSync.existsSync(shell) ? shell : null;
}

export function applyPosixNpmScriptShellEnv(env: NodeJS.ProcessEnv): void {
  if (hasNpmScriptShellSetting(env)) {
    return;
  }
  const scriptShell = resolvePosixNpmScriptShell(env);
  if (scriptShell) {
    env.NPM_CONFIG_SCRIPT_SHELL = scriptShell;
  }
}
