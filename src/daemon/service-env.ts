import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isNodeVersionManagerRuntime,
  resolveLinuxSystemCaBundle,
} from "../bootstrap/node-extra-ca-certs.js";
import { resolveNodeStartupTlsEnvironment } from "../bootstrap/node-startup-env.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { VERSION } from "../version.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";
import { resolveGatewayStateDir } from "./paths.js";

export { isNodeVersionManagerRuntime, resolveLinuxSystemCaBundle };

export type MinimalServicePathOptions = {
  platform?: NodeJS.Platform;
  extraDirs?: string[];
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  existsSync?: (candidate: string) => boolean;
};

type BuildServicePathOptions = MinimalServicePathOptions & {
  env?: Record<string, string | undefined>;
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
): void {
  dirs.push(`${home}/.local/bin`);
  dirs.push(`${home}/.npm-global/bin`);
  dirs.push(`${home}/bin`);
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
): void {
  const nixProfiles = env?.NIX_PROFILES?.trim();
  if (nixProfiles) {
    for (const profile of nixProfiles.split(/\s+/).toReversed()) {
      addEnvConfiguredBinDir(dirs, appendSubdir(profile, "bin"), options);
    }
  } else {
    dirs.push(`${home}/.nix-profile/bin`);
  }
}

function resolveSystemPathDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  }
  if (platform === "linux") {
    return ["/usr/local/bin", "/usr/bin", "/bin"];
  }
  return [];
}

/**
 * Resolve common user bin directories for macOS.
 * These are paths where npm global installs and node version managers typically place binaries.
 *
 * Key differences from Linux:
 * - fnm: macOS uses ~/Library/Application Support/fnm (not ~/.local/share/fnm)
 * - pnpm: macOS uses ~/Library/pnpm (not ~/.local/share/pnpm)
 */
export function resolveDarwinUserBinDirs(
  home: string | undefined,
  env?: Record<string, string | undefined>,
  existsSync: (candidate: string) => boolean = fs.existsSync,
  options: Pick<MinimalServicePathOptions, "cwd" | "home"> = {},
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];
  const pathOptions = { ...options, home };

  // Env-configured bin roots (override defaults when present).
  // Note: FNM_DIR on macOS defaults to ~/Library/Application Support/fnm
  // Note: PNPM_HOME on macOS defaults to ~/Library/pnpm
  addCommonEnvConfiguredBinDirs(dirs, env, pathOptions);
  // nvm: no stable default path, relies on env or user's shell config
  // User must set NVM_DIR and source nvm.sh for it to work
  addEnvConfiguredBinDir(dirs, env?.NVM_DIR, pathOptions);
  // fnm: use aliases/default (not current)
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "aliases/default/bin"), pathOptions);
  // pnpm: binary is directly in PNPM_HOME (not in bin subdirectory)

  // Common user bin directories
  addCommonUserBinDirs(dirs, home, existsSync);

  // Nix Home Manager (cross-platform)
  addNixProfileBinDirs(dirs, home, env, pathOptions);

  // Node version managers - macOS specific paths
  // nvm: no stable default path, depends on user's shell configuration
  // fnm: macOS default is ~/Library/Application Support/fnm, not ~/.fnm
  addExistingDir(dirs, `${home}/Library/Application Support/fnm/aliases/default/bin`, existsSync); // fnm default
  addExistingDir(dirs, `${home}/.fnm/aliases/default/bin`, existsSync); // fnm if customized to ~/.fnm
  // pnpm: macOS default is ~/Library/pnpm, not ~/.local/share/pnpm
  addExistingDir(dirs, `${home}/Library/pnpm`, existsSync); // pnpm default
  addExistingDir(dirs, `${home}/.local/share/pnpm`, existsSync); // pnpm XDG fallback

  return dirs;
}

/**
 * Resolve common user bin directories for Linux.
 * These are paths where npm global installs and node version managers typically place binaries.
 */
export function resolveLinuxUserBinDirs(
  home: string | undefined,
  env?: Record<string, string | undefined>,
  existsSync: (candidate: string) => boolean = fs.existsSync,
  options: Pick<MinimalServicePathOptions, "cwd" | "home"> = {},
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];
  const pathOptions = { ...options, home };

  // Env-configured bin roots (override defaults when present).
  addCommonEnvConfiguredBinDirs(dirs, env, pathOptions);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.NVM_DIR, "current/bin"), pathOptions);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "aliases/default/bin"), pathOptions);
  addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "current/bin"), pathOptions);

  // Common user bin directories
  addCommonUserBinDirs(dirs, home, existsSync);

  // Nix Home Manager (cross-platform)
  addNixProfileBinDirs(dirs, home, env, pathOptions);

  // Node version managers
  addExistingDir(dirs, `${home}/.nvm/current/bin`, existsSync); // nvm with current symlink
  addExistingDir(dirs, `${home}/.local/share/fnm/aliases/default/bin`, existsSync); // fnm default
  addExistingDir(dirs, `${home}/.local/share/fnm/current/bin`, existsSync); // fnm legacy current symlink
  addExistingDir(dirs, `${home}/.fnm/aliases/default/bin`, existsSync); // fnm if customized to ~/.fnm
  addExistingDir(dirs, `${home}/.fnm/current/bin`, existsSync); // fnm legacy current symlink
  addExistingDir(dirs, `${home}/.local/share/pnpm`, existsSync); // pnpm global bin

  return dirs;
}

export function getMinimalServicePathParts(options: MinimalServicePathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return [];
  }

  const parts: string[] = [];
  const extraDirs = options.extraDirs ?? [];
  const systemDirs = resolveSystemPathDirs(platform);

  // Add user bin directories for version managers (npm global, nvm, fnm, volta, etc.)
  const existsSync = options.existsSync ?? fs.existsSync;
  const userDirs =
    platform === "linux"
      ? resolveLinuxUserBinDirs(options.home, options.env, existsSync, options)
      : platform === "darwin"
        ? resolveDarwinUserBinDirs(options.home, options.env, existsSync, options)
        : [];

  const add = (dir: string) => {
    if (!dir) {
      return;
    }
    if (!parts.includes(dir)) {
      parts.push(dir);
    }
  };

  for (const dir of extraDirs) {
    add(dir);
  }
  // User dirs first so user-installed binaries take precedence
  for (const dir of userDirs) {
    add(dir);
  }
  for (const dir of systemDirs) {
    add(dir);
  }

  return parts;
}

export function getMinimalServicePathPartsFromEnv(options: BuildServicePathOptions = {}): string[] {
  const env = options.env ?? process.env;
  return getMinimalServicePathParts({
    ...options,
    home: options.home ?? env.HOME,
    env,
  });
}

export function buildMinimalServicePath(options: BuildServicePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return env.PATH ?? "";
  }

  return getMinimalServicePathPartsFromEnv({ ...options, env }).join(path.posix.delimiter);
}

export function buildServiceEnvironment(params: {
  env: Record<string, string | undefined>;
  port: number;
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
  const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    OPENCLAW_PROFILE: profile,
    OPENCLAW_WRAPPER: wrapperPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_LAUNCHD_LABEL: resolvedLaunchdLabel,
    OPENCLAW_SYSTEMD_UNIT: systemdUnit,
    OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
    OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
    OPENCLAW_SERVICE_VERSION: VERSION,
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
  const allowInsecurePrivateWs = normalizeOptionalString(env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS);
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: allowInsecurePrivateWs,
    OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    OPENCLAW_LOG_PREFIX: "node",
    OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
    OPENCLAW_SERVICE_VERSION: VERSION,
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
