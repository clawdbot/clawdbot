import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { uniqueStrings } from "../shared/string-normalization.js";

export type NpmProjectInstallEnvOptions = {
  cacheDir?: string;
  npmConfigCwd?: string;
  npmConfigPrefix?: string | null;
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

const NPM_FRESHNESS_BYPASS_KEYS = [
  "NPM_CONFIG_BEFORE",
  "npm_config_before",
  "NPM_CONFIG_MIN_RELEASE_AGE",
  "npm_config_min_release_age",
  "NPM_CONFIG_MIN-RELEASE-AGE",
  "npm_config_min-release-age",
] as const;

type NpmFreshnessBypassMode = "before" | "min-release-age";

type NpmFreshnessConfigScope = {
  npmConfigCwd?: string;
  npmConfigPrefix?: string | null;
};

const NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec"];
const NPM_GLOBAL_CONFIG_PATH_CACHE = new Map<string, string | null>();
const NPM_GLOBAL_CONFIG_PATH_CACHE_ENV_KEYS = [
  ...NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS,
  "NPM_CONFIG_GLOBALCONFIG",
  "npm_config_globalconfig",
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_userconfig",
  "HOME",
  "PREFIX",
  "USERPROFILE",
] as const;

function resolveEnvPath(env: NodeJS.ProcessEnv, upperKey: string, lowerKey: string): string | null {
  const raw = env[upperKey]?.trim() || env[lowerKey]?.trim();
  return raw ? resolveNpmConfigPath(raw, env) : null;
}

function resolveHomeNpmrc(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ".npmrc");
}

function replaceNpmEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/gu,
    (original, escapes, name, modifier) => {
      const fallback = modifier === "?" ? "" : `\${${name}}`;
      const resolved = env[name] !== undefined ? env[name] : fallback;
      if (escapes.length % 2) {
        return original.slice((escapes.length + 1) / 2);
      }
      return `${escapes.slice(escapes.length / 2)}${resolved}`;
    },
  );
}

function resolveNpmConfigPath(rawPath: string, env: NodeJS.ProcessEnv): string {
  const expanded = replaceNpmEnvRefs(rawPath, env);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const homePattern = process.platform === "win32" ? /^~(\/|\\)/u : /^~\//u;
  return homePattern.test(expanded) && home
    ? path.resolve(home, expanded.slice(2))
    : path.resolve(expanded);
}

function createNpmConfigPathProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const probeEnv = { ...env };
  for (const key of NPM_FRESHNESS_BYPASS_KEYS) {
    delete probeEnv[key];
  }
  for (const key of NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS) {
    if (probeEnv[key] == null && process.env[key] != null) {
      probeEnv[key] = process.env[key];
    }
  }
  return probeEnv;
}

function readNpmGlobalConfigPath(
  env: NodeJS.ProcessEnv,
  scope: NpmFreshnessConfigScope,
): string | null {
  const scopedGlobalConfig = resolveScopedGlobalNpmrc(scope);
  if (scopedGlobalConfig) {
    return scopedGlobalConfig;
  }
  const configuredGlobalConfig = resolveEnvPath(
    env,
    "NPM_CONFIG_GLOBALCONFIG",
    "npm_config_globalconfig",
  );
  if (configuredGlobalConfig) {
    return configuredGlobalConfig;
  }
  const configuredPrefix = resolveEnvPath(env, "NPM_CONFIG_PREFIX", "npm_config_prefix");
  if (configuredPrefix) {
    return path.join(configuredPrefix, "etc", "npmrc");
  }
  const cacheKey = buildNpmGlobalConfigPathCacheKey(env, scope);
  if (NPM_GLOBAL_CONFIG_PATH_CACHE.has(cacheKey)) {
    return NPM_GLOBAL_CONFIG_PATH_CACHE.get(cacheKey) ?? null;
  }
  try {
    const raw = execFileSync("npm", ["config", "get", "globalconfig"], {
      encoding: "utf-8",
      env: {
        ...createNpmConfigPathProbeEnv(env),
        ...(scope.npmConfigPrefix ? { npm_config_prefix: scope.npmConfigPrefix } : {}),
      },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    const resolved = raw && raw !== "null" && raw !== "undefined" ? raw : null;
    NPM_GLOBAL_CONFIG_PATH_CACHE.set(cacheKey, resolved);
    return resolved;
  } catch {
    NPM_GLOBAL_CONFIG_PATH_CACHE.set(cacheKey, null);
    return null;
  }
}

function buildNpmGlobalConfigPathCacheKey(
  env: NodeJS.ProcessEnv,
  scope: NpmFreshnessConfigScope,
): string {
  const configFiles = uniqueStrings(
    [
      resolveScopedProjectNpmrc(scope),
      resolveEnvPath(env, "NPM_CONFIG_USERCONFIG", "npm_config_userconfig") ??
        resolveHomeNpmrc(env),
      resolveEnvPath(env, "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"),
      resolveScopedGlobalNpmrc(scope),
    ].filter((file): file is string => Boolean(file)),
  );
  return JSON.stringify({
    cwd: scope.npmConfigCwd?.trim() || safeCwd(),
    prefix: scope.npmConfigPrefix?.trim() ?? "",
    env: Object.fromEntries(
      NPM_GLOBAL_CONFIG_PATH_CACHE_ENV_KEYS.map((key) => [key, env[key] ?? process.env[key] ?? ""]),
    ),
    configFiles: configFiles.map((filePath) => ({
      path: filePath,
      signature: readFileSignature(filePath),
    })),
  });
}

function readFileSignature(filePath: string): string {
  try {
    const stat = fsSync.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

function resolveScopedProjectNpmrc(scope: NpmFreshnessConfigScope): string | null {
  const scopedCwd = scope.npmConfigCwd?.trim();
  if (scopedCwd) {
    return path.join(scopedCwd, ".npmrc");
  }
  try {
    const cwd = process.cwd();
    return cwd ? path.join(cwd, ".npmrc") : null;
  } catch {
    return null;
  }
}

function resolveScopedGlobalNpmrc(scope: NpmFreshnessConfigScope): string | null {
  const prefix = scope.npmConfigPrefix?.trim();
  return prefix ? path.join(prefix, "etc", "npmrc") : null;
}

function resolveNpmConfigFiles(
  env: NodeJS.ProcessEnv,
  scope: NpmFreshnessConfigScope = {},
): string[] {
  const files = [
    resolveScopedProjectNpmrc(scope),
    resolveEnvPath(env, "NPM_CONFIG_USERCONFIG", "npm_config_userconfig") ?? resolveHomeNpmrc(env),
    resolveEnvPath(env, "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"),
    resolveScopedGlobalNpmrc(scope),
    readNpmGlobalConfigPath(env, scope),
  ];
  return uniqueStrings(files.filter((file): file is string => Boolean(file)));
}

function hasNpmrcConfigKey(filePath: string, key: string): boolean {
  try {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`^\\s*${escapedKey}\\s*=`, "imu");
    return pattern.test(raw);
  } catch {
    return false;
  }
}

function hasRawNpmConfigKey(
  env: NodeJS.ProcessEnv,
  key: "before" | "min-release-age",
  scope: NpmFreshnessConfigScope,
): boolean {
  return resolveNpmConfigFiles(env, scope).some((file) => hasNpmrcConfigKey(file, key));
}

function resolveNpmFreshnessBypassMode(
  env: NodeJS.ProcessEnv,
  scope: NpmFreshnessConfigScope,
): NpmFreshnessBypassMode {
  if (process.platform === "win32") {
    return "before";
  }
  if (hasRawNpmConfigKey(env, "min-release-age", scope)) {
    return "min-release-age";
  }
  return hasRawNpmConfigKey(env, "before", scope) ? "before" : "min-release-age";
}

export function createNpmFreshnessBypassArgs(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  scope: NpmFreshnessConfigScope = {},
): string[] {
  if (resolveNpmFreshnessBypassMode(env, scope) === "min-release-age") {
    return ["--min-release-age=0"];
  }
  return [`--before=${now.toISOString()}`];
}

export function applyNpmFreshnessBypassEnv(
  env: NodeJS.ProcessEnv,
  now = new Date(),
  scope: NpmFreshnessConfigScope = {},
): void {
  const [arg] = createNpmFreshnessBypassArgs(env, now, scope);
  for (const key of NPM_FRESHNESS_BYPASS_KEYS) {
    if (process.platform === "win32" && key.includes("-")) {
      delete env[key];
      continue;
    }
    env[key] = "";
  }
  if (arg?.startsWith("--before=")) {
    env.npm_config_before = arg.slice("--before=".length);
  } else if (arg === "--min-release-age=0") {
    env.npm_config_min_release_age = "0";
  }
}

export function createNpmProjectInstallEnv(
  env: NodeJS.ProcessEnv,
  options: NpmProjectInstallEnvOptions = {},
  now = new Date(),
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
  applyNpmFreshnessBypassEnv(installEnv, now, options);
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
