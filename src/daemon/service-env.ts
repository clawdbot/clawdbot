/** Builds minimal, portable environment blocks for managed daemon services. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveNodeStartupTlsEnvironment } from "../bootstrap/node-startup-env.js";
import type { GatewayDaemonRuntime } from "../commands/daemon-runtime.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
  resolveNodeServiceIdentityEnvironment,
} from "./constants.js";
import { resolveGatewayHeapNodeOptions } from "./gateway-heap.js";
import { resolveGatewayStateDir } from "./paths.js";

type MinimalServicePathOptions = {
  platform?: NodeJS.Platform;
  extraDirs?: string[];
  includeUserDirs?: boolean;
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  existsSync?: (candidate: string) => boolean;
  includeMissingUserBinDefaults?: boolean;
};

type SharedServiceEnvironmentFields = {
  stateDir: string | undefined;
  configPath: string | undefined;
  tmpDir: string;
  minimalPath: string | undefined;
  proxyEnv: Record<string, string | undefined>;
  nodeCaCerts: string | undefined;
  nodeUseSystemCa: string | undefined;
};

export const SERVICE_PROXY_ENV_KEYS = [
  "OPENCLAW_PROXY_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
] as const;

function readServiceProxyEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  // Service env intentionally preserves only the canonical OpenClaw proxy knob;
  // generic shell proxy vars are audited but not frozen into services.
  const proxyUrl = normalizeOptionalString(env.OPENCLAW_PROXY_URL);
  return proxyUrl ? { OPENCLAW_PROXY_URL: proxyUrl } : {};
}

function normalizeServicePathDir(dir: string | undefined): string | undefined {
  const trimmed = dir?.trim();
  // Service PATH snapshots are only emitted for macOS/Linux; keep POSIX semantics
  // even when tests or helper callers run on Windows.
  if (!trimmed || !path.posix.isAbsolute(trimmed)) {
    return undefined;
  }
  return path.posix.normalize(trimmed);
}

function realpathServicePathDir(dir: string): string | undefined {
  try {
    return path.posix.normalize(fs.realpathSync.native(dir));
  } catch {
    return undefined;
  }
}

function realpathExistingServicePathDir(dir: string): string | undefined {
  const parts: string[] = [];
  let current = dir;
  // Resolve the nearest existing ancestor so future-created bin dirs can still
  // be compared against the install workspace realpath.
  while (current && current !== path.posix.dirname(current)) {
    const realCurrent = realpathServicePathDir(current);
    if (realCurrent) {
      return path.posix.normalize(path.posix.join(realCurrent, ...parts.toReversed()));
    }
    parts.push(path.posix.basename(current));
    current = path.posix.dirname(current);
  }
  const realRoot = realpathServicePathDir(current);
  return realRoot
    ? path.posix.normalize(path.posix.join(realRoot, ...parts.toReversed()))
    : undefined;
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isUnsafeProcPath(candidate: string): boolean {
  return candidate === "/proc" || candidate.startsWith("/proc/");
}

function isWorkspaceDerivedPath(
  dir: string,
  options: Pick<MinimalServicePathOptions, "cwd" | "home">,
): boolean {
  // Install-time workspace env vars must not become durable service PATH entries.
  if (isUnsafeProcPath(dir)) {
    return true;
  }
  const cwd = normalizeServicePathDir(options.cwd ?? process.cwd());
  if (!cwd) {
    return false;
  }
  const home = normalizeServicePathDir(options.home);
  if (home && cwd === home) {
    return false;
  }
  if (isSameOrChildPath(dir, cwd)) {
    return true;
  }
  const realDir = realpathExistingServicePathDir(dir);
  const realCwd = realpathServicePathDir(cwd);
  const realHome = home ? realpathServicePathDir(home) : undefined;
  return Boolean(realDir && realCwd && realHome !== realCwd && isSameOrChildPath(realDir, realCwd));
}

function addEnvConfiguredBinDir(
  dirs: string[],
  dir: string | undefined,
  options: Pick<MinimalServicePathOptions, "cwd" | "home">,
): void {
  const normalized = normalizeServicePathDir(dir);
  if (!normalized || isWorkspaceDerivedPath(normalized, options)) {
    return;
  }
  dirs.push(normalized);
}

function appendSubdir(base: string | undefined, subdir: string): string | undefined {
  if (!base) {
    return undefined;
  }
  return base.endsWith(`/${subdir}`) ? base : path.posix.join(base, subdir);
}

function addExistingDir(
  dirs: string[],
  candidate: string,
  existsSync: (candidate: string) => boolean,
): void {
  if (existsSync(candidate)) {
    dirs.push(candidate);
  }
}

function addCommonUserBinDirs(
  dirs: string[],
  home: string,
  existsSync: (candidate: string) => boolean,
  includeMissingDefaults: boolean,
): void {
  const addDefault = includeMissingDefaults
    ? (candidate: string) => dirs.push(candidate)
    : (candidate: string) => addExistingDir(dirs, candidate, existsSync);
  addDefault(`${home}/.local/bin`);
  addDefault(`${home}/.npm-global/bin`);
  addDefault(`${home}/bin`);
  addExistingDir(dirs, `${home}/.volta/bin`, existsSync);
  addExistingDir(dirs, `${home}/.asdf/shims`, existsSync);
  addExistingDir(dirs, `${home}/.bun/bin`, existsSync);
}

function addCommonEnvConfiguredBinDirs(
  dirs: string[],
  env: Record<string, string | undefined> | undefined,
  options: Pick<MinimalServicePathOptions, "cwd" | "home">,
): void {
  addEnvConfiguredBinDir(dirs, env?.PNPM_HOME, options);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.PNPM_HOME, "bin"), options);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.NPM_CONFIG_PREFIX, "bin"), options);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.BUN_INSTALL, "bin"), options);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.VOLTA_HOME, "bin"), options);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.ASDF_DATA_DIR, "shims"), options);
}

// Nix shell precedence: rightmost profile in NIX_PROFILES = highest priority.
// When NIX_PROFILES is absent, fall back to the default single-user profile.
function addNixProfileBinDirs(
  dirs: string[],
  home: string,
  env: Record<string, string | undefined> | undefined,
  options: Pick<MinimalServicePathOptions, "cwd" | "home">,
  includeMissingDefault: boolean,
  existsSync: (candidate: string) => boolean,
): void {
  const nixProfiles = env?.NIX_PROFILES?.trim();
  if (nixProfiles) {
    for (const profile of nixProfiles.split(/\s+/).toReversed()) {
      addEnvConfiguredBinDir(dirs, appendSubdir(profile, "bin"), options);
    }
  } else {
    const defaultProfileBin = `${home}/.nix-profile/bin`;
    if (includeMissingDefault) {
      dirs.push(defaultProfileBin);
    } else {
      addExistingDir(dirs, defaultProfileBin, existsSync);
    }
  }
}

function resolveSystemPathDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];
  }
  if (platform === "linux") {
    return ["/usr/local/bin", "/usr/bin", "/bin"];
  }
  return [];
}

/** Resolve common user bin directories while preserving platform-specific manager roots. */
function resolveUserBinDirs(
  home: string | undefined,
  platform: "darwin" | "linux",
  env?: Record<string, string | undefined>,
  existsSync: (candidate: string) => boolean = fs.existsSync,
  options: Pick<MinimalServicePathOptions, "cwd" | "home" | "includeMissingUserBinDefaults"> = {},
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];
  const pathOptions = { ...options, home };
  const includeMissingUserBinDefaults = options.includeMissingUserBinDefaults ?? true;

  addCommonEnvConfiguredBinDirs(dirs, env, pathOptions);
  addEnvConfiguredBinDir(
    dirs,
    platform === "darwin" ? env?.NVM_DIR : appendSubdir(env?.NVM_DIR, "current/bin"),
    pathOptions,
  );
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "aliases/default/bin"), pathOptions);
  if (platform === "linux") {
    addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "current/bin"), pathOptions);
  }
  addCommonUserBinDirs(dirs, home, existsSync, includeMissingUserBinDefaults);
  addNixProfileBinDirs(dirs, home, env, pathOptions, includeMissingUserBinDefaults, existsSync);
  // macOS uses Library roots; Linux uses XDG/current symlinks. Preserve both
  // the pnpm root (v10) and its bin subdirectory (v11) in their original order.
  const managerDirs =
    platform === "darwin"
      ? [
          "Library/Application Support/fnm/aliases/default/bin",
          ".fnm/aliases/default/bin",
          "Library/pnpm/bin",
          "Library/pnpm",
          ".local/share/pnpm/bin",
          ".local/share/pnpm",
        ]
      : [
          ".nvm/current/bin",
          ".local/share/fnm/aliases/default/bin",
          ".local/share/fnm/current/bin",
          ".fnm/aliases/default/bin",
          ".fnm/current/bin",
          ".local/share/pnpm/bin",
          ".local/share/pnpm",
        ];
  for (const directory of managerDirs) {
    addExistingDir(dirs, `${home}/${directory}`, existsSync);
  }
  return dirs;
}

function getMinimalServicePathParts(options: MinimalServicePathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // Windows scheduled tasks inherit PATH from the task host; generated cmd
    // launchers should not freeze install-time PATH snapshots.
    return [];
  }

  const extraDirs = options.extraDirs ?? [];
  const systemDirs = resolveSystemPathDirs(platform);
  const includeUserDirs = options.includeUserDirs ?? platform !== "darwin";

  const existsSync = options.existsSync ?? fs.existsSync;
  const userDirs =
    includeUserDirs && (platform === "linux" || platform === "darwin")
      ? resolveUserBinDirs(options.home, platform, options.env, existsSync, options)
      : [];

  return [...new Set([...extraDirs, ...systemDirs, ...userDirs].filter(Boolean))];
}

export function getMinimalServicePathPartsFromEnv(
  options: MinimalServicePathOptions = {},
): string[] {
  const env = options.env ?? process.env;
  return getMinimalServicePathParts({
    ...options,
    home: options.home ?? env.HOME,
    env,
  });
}

function buildMinimalServicePath(options: MinimalServicePathOptions = {}): string {
  const env = options.env ?? process.env;
  return getMinimalServicePathPartsFromEnv({ ...options, env }).join(path.posix.delimiter);
}

function resolveGatewaySystemdUnitEnv(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_SYSTEMD_UNIT);
  if (override) {
    return override.endsWith(".service") ? override : `${override}.service`;
  }
  return `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
}

export function buildServiceEnvironment(params: {
  env: Record<string, string | undefined>;
  port: number;
  existingNodeOptions?: string;
  runtime?: GatewayDaemonRuntime;
  launchdLabel?: string;
  platform?: NodeJS.Platform;
  extraPathDirs?: string[];
  execPath?: string;
}): Record<string, string | undefined> {
  const { env, port, launchdLabel, extraPathDirs } = params;
  const platform = params.platform ?? process.platform;
  const sharedEnv = resolveSharedServiceEnvironmentFields(
    env,
    platform,
    extraPathDirs,
    params.execPath,
  );
  const profile = env.OPENCLAW_PROFILE;
  const wrapperPath = normalizeOptionalString(env.OPENCLAW_WRAPPER);
  const resolvedLaunchdLabel =
    launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : undefined);
  const systemdUnit = resolveGatewaySystemdUnitEnv(env);
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    // An empty assignment clears supervisor ambient options; omission would
    // allow preloads/debug flags to bypass the heap-only service boundary.
    NODE_OPTIONS: resolveGatewayHeapNodeOptions(
      params.existingNodeOptions,
      wrapperPath ? undefined : params.runtime,
    ),
    OPENCLAW_PROFILE: profile,
    OPENCLAW_WRAPPER: wrapperPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_LAUNCHD_LABEL: resolvedLaunchdLabel,
    OPENCLAW_SYSTEMD_UNIT: systemdUnit,
    OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
    OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
  };
}

export function buildNodeServiceEnvironment(params: {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  extraPathDirs?: string[];
  execPath?: string;
}): Record<string, string | undefined> {
  const { env, extraPathDirs } = params;
  const platform = params.platform ?? process.platform;
  const sharedEnv = resolveSharedServiceEnvironmentFields(
    env,
    platform,
    extraPathDirs,
    params.execPath,
  );
  const gatewayToken = normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN);
  const gatewayPassword = normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD);
  const cloudflareAccessClientId = normalizeOptionalString(env.CF_ACCESS_CLIENT_ID);
  const cloudflareAccessClientSecret = normalizeOptionalString(env.CF_ACCESS_CLIENT_SECRET);
  const allowInsecurePrivateWs = normalizeOptionalString(env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS);
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_GATEWAY_PASSWORD: gatewayPassword,
    CF_ACCESS_CLIENT_ID: cloudflareAccessClientId,
    CF_ACCESS_CLIENT_SECRET: cloudflareAccessClientSecret,
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: allowInsecurePrivateWs,
    // launchd manager variables outlive the installer. Worker snapshots scope
    // this host fence by the canonical managed-node service identity.
    NODE_DISABLE_COMPILE_CACHE: platform === "darwin" ? "1" : undefined,
    ...resolveNodeServiceIdentityEnvironment(),
  };
}

function buildCommonServiceEnvironment(
  env: Record<string, string | undefined>,
  sharedEnv: SharedServiceEnvironmentFields,
): Record<string, string | undefined> {
  const serviceEnv: Record<string, string | undefined> = {
    HOME: env.HOME,
    TMPDIR: sharedEnv.tmpDir,
    NODE_EXTRA_CA_CERTS: sharedEnv.nodeCaCerts,
    NODE_USE_SYSTEM_CA: sharedEnv.nodeUseSystemCa,
    OPENCLAW_STATE_DIR: sharedEnv.stateDir,
    OPENCLAW_CONFIG_PATH: sharedEnv.configPath,
    ...sharedEnv.proxyEnv,
  };
  if (sharedEnv.minimalPath) {
    serviceEnv.PATH = sharedEnv.minimalPath;
  }
  return serviceEnv;
}

function resolveServiceTmpDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    try {
      return path.join(resolveGatewayStateDir(env), "tmp");
    } catch {
      return env.TMPDIR?.trim() || os.tmpdir();
    }
  }
  return env.TMPDIR?.trim() || os.tmpdir();
}

function resolveSharedServiceEnvironmentFields(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  extraPathDirs: string[] | undefined,
  execPath?: string,
): SharedServiceEnvironmentFields {
  const stateDir = env.OPENCLAW_STATE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  const tmpDir = resolveServiceTmpDir(env, platform);
  // On macOS, launchd services don't inherit the shell environment, so Node's undici/fetch
  // cannot locate the system CA bundle. Default to /etc/ssl/cert.pem so TLS verification
  // works correctly when running as a LaunchAgent without extra user configuration.
  // On Linux, nvm-installed Node may need the host CA bundle injected before startup.
  const startupTlsEnv = resolveNodeStartupTlsEnvironment({
    env,
    platform,
    execPath,
  });
  return {
    stateDir,
    configPath,
    tmpDir,
    // On Windows, Scheduled Tasks should inherit the current task PATH instead of
    // freezing the install-time snapshot into gateway.cmd/node-host.cmd.
    minimalPath:
      platform === "win32"
        ? undefined
        : buildMinimalServicePath({ env, platform, extraDirs: extraPathDirs }),
    proxyEnv: readServiceProxyEnvironment(env),
    nodeCaCerts: startupTlsEnv.NODE_EXTRA_CA_CERTS,
    nodeUseSystemCa: startupTlsEnv.NODE_USE_SYSTEM_CA,
  };
}
