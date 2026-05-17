import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";

export type NpmProjectInstallEnvOptions = {
  cacheDir?: string;
};

const NPM_CONFIG_SCRIPT_SHELL_KEYS = ["NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell"];

const NPM_CONFIG_KEYS_TO_RESET = new Set([
  "npm_config_before",
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
  "npm_config_min_release_age",
  "npm_config_min-release-age",
]);

const NPM_FRESHNESS_BYPASS_KEYS = [
  "NPM_CONFIG_BEFORE",
  "npm_config_before",
  "NPM_CONFIG_MIN_RELEASE_AGE",
  "npm_config_min_release_age",
  "NPM_CONFIG_MIN-RELEASE-AGE",
  "npm_config_min-release-age",
] as const;

const NPM_CONFIG_PROBE_PARENT_ENV_KEYS = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec"];

function createNpmConfigProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const probeEnv = { ...env };
  for (const key of NPM_CONFIG_PROBE_PARENT_ENV_KEYS) {
    if (probeEnv[key] == null && process.env[key] != null) {
      probeEnv[key] = process.env[key];
    }
  }
  return probeEnv;
}

function readNpmConfigValue(key: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("npm", ["config", "get", key], {
      encoding: "utf-8",
      env: createNpmConfigProbeEnv(env),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
  } catch {
    return null;
  }
}

function isNullNpmConfigValue(value: string | null): boolean {
  return !value || value === "null" || value === "undefined";
}

function hasExplicitNpmBeforeConfig(env: NodeJS.ProcessEnv): boolean {
  const minReleaseAge = readNpmConfigValue("min-release-age", env);
  if (!isNullNpmConfigValue(minReleaseAge)) {
    return false;
  }
  return !isNullNpmConfigValue(readNpmConfigValue("before", env));
}

export function createNpmFreshnessBypassArgs(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): string[] {
  if (hasExplicitNpmBeforeConfig(env)) {
    return [`--before=${now.toISOString()}`];
  }
  return ["--min-release-age=0"];
}

export function applyNpmFreshnessBypassEnv(env: NodeJS.ProcessEnv): void {
  for (const key of NPM_FRESHNESS_BYPASS_KEYS) {
    env[key] = "";
  }
  const [arg] = createNpmFreshnessBypassArgs(env);
  if (arg?.startsWith("--before=")) {
    env.npm_config_before = arg.slice("--before=".length);
    return;
  }
  env["npm_config_min-release-age"] = "0";
}

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
  applyNpmFreshnessBypassEnv(installEnv);
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
