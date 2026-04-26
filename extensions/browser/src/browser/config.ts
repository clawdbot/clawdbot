import os from "node:os";
import path from "node:path";
import {
  normalizeOptionalString,
  normalizeOptionalTrimmedStringList,
} from "openclaw/plugin-sdk/text-runtime";
import {
  type BrowserConfig,
  type BrowserProfileConfig,
  type OpenClawConfig,
} from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";
import {
  DEFAULT_BROWSER_CONTROL_PORT,
  deriveDefaultBrowserCdpPortRange,
  deriveDefaultBrowserControlPort,
} from "../config/port-defaults.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { parseBrowserHttpUrl, redactCdpUrl, isLoopbackHost } from "./cdp.helpers.js";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS,
  DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS,
  DEFAULT_BROWSER_TAB_CLEANUP_IDLE_MINUTES,
  DEFAULT_BROWSER_TAB_CLEANUP_MAX_TABS_PER_SESSION,
  DEFAULT_BROWSER_TAB_CLEANUP_SWEEP_MINUTES,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { resolveBrowserControlAuth, type BrowserControlAuth } from "./control-auth.js";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";

export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS,
  DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  DEFAULT_UPLOAD_DIR,
  parseBrowserHttpUrl,
  redactCdpUrl,
  resolveBrowserControlAuth,
};
export type { BrowserControlAuth };
export { parseBrowserHttpUrl as parseHttpUrl };

type BrowserSsrFPolicyCompat = NonNullable<BrowserConfig["ssrfPolicy"]> & {
  /**
   * Legacy raw-config alias. Keep it out of the public BrowserConfig type while
   * still accepting old user files until doctor rewrites them.
   */
  allowPrivateNetwork?: boolean;
};

export type ResolvedBrowserConfig = {
  enabled: boolean;
  evaluateEnabled: boolean;
  controlPort: number;
  cdpPortRangeStart: number;
  cdpPortRangeEnd: number;
  cdpProtocol: "http" | "https";
  cdpHost: string;
  cdpIsLoopback: boolean;
  remoteCdpTimeoutMs: number;
  remoteCdpHandshakeTimeoutMs: number;
  localLaunchTimeoutMs: number;
  localCdpReadyTimeoutMs: number;
  actionTimeoutMs: number;
  color: string;
  executablePath?: string;
  headless: boolean;
  headlessSource?: "config" | "default";
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
  tabCleanup: ResolvedBrowserTabCleanupConfig;
  ssrfPolicy?: SsrFPolicy;
  extraArgs: string[];
};

export type ResolvedBrowserTabCleanupConfig = {
  enabled: boolean;
  idleMinutes: number;
  maxTabsPerSession: number;
  sweepMinutes: number;
};

export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  userDataDir?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  color: string;
  driver: "openclaw" | "existing-session";
  executablePath?: string;
  headless: boolean;
  headlessSource?: "profile" | "config" | "default";
  attachOnly: boolean;
};

const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
const MAX_BROWSER_STARTUP_TIMEOUT_MS = 120_000;
export const OPENCLAW_BROWSER_HEADLESS_ENV = "OPENCLAW_BROWSER_HEADLESS";

export type ManagedBrowserHeadlessSource =
  | "request"
  | "env"
  | "profile"
  | "config"
  | "linux-display-fallback"
  | "default";

export type ManagedBrowserHeadlessMode = {
  headless: boolean;
  source: ManagedBrowserHeadlessSource;
};

export type ManagedBrowserHeadlessOptions = {
  headlessOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function normalizeHexColor(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return DEFAULT_OPENCLAW_BROWSER_COLOR;
  }
  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return DEFAULT_OPENCLAW_BROWSER_COLOR;
  }
  return normalized.toUpperCase();
}

function normalizeTimeoutMs(raw: number | undefined, fallback: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return value < 0 ? fallback : value;
}

function normalizeStartupTimeoutMs(raw: number | undefined, fallback: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  if (value <= 0) {
    return fallback;
  }
  return Math.min(value, MAX_BROWSER_STARTUP_TIMEOUT_MS);
}

function normalizeNonNegativeInteger(raw: number | undefined, fallback: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return value < 0 ? fallback : value;
}

function normalizePositiveInteger(raw: number | undefined, fallback: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return value <= 0 ? fallback : value;
}

function normalizeExecutablePath(raw: string | undefined): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  if (!/^~(?=$|[\\/])/.test(value)) {
    return value;
  }
  return path.resolve(value.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function normalizeExistingSessionCdpUrl(
  raw: string | undefined,
  profileName: string,
): { cdpUrl: string; cdpHost: string; cdpIsLoopback: boolean } | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`browser.profiles.${profileName}.cdpUrl must be a valid URL.`);
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`browser.profiles.${profileName}.cdpUrl must use http, https, ws, or wss.`);
  }

  const normalized =
    parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString().replace(/\/$/, "")
      : parsed.toString();
  return {
    cdpUrl: normalized,
    cdpHost: parsed.hostname,
    cdpIsLoopback: isLoopbackHost(parsed.hostname),
  };
}

function hasLinuxDisplay(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

function isLocalManagedProfile(profile: ResolvedBrowserProfile): boolean {
  return profile.driver === "openclaw" && profile.cdpIsLoopback && !profile.attachOnly;
}

function resolveBrowserTabCleanupConfig(
  cfg: BrowserConfig | undefined,
): ResolvedBrowserTabCleanupConfig {
  const raw = cfg?.tabCleanup;
  return {
    enabled: raw?.enabled ?? true,
    idleMinutes: normalizeNonNegativeInteger(
      raw?.idleMinutes,
      DEFAULT_BROWSER_TAB_CLEANUP_IDLE_MINUTES,
    ),
    maxTabsPerSession: normalizeNonNegativeInteger(
      raw?.maxTabsPerSession,
      DEFAULT_BROWSER_TAB_CLEANUP_MAX_TABS_PER_SESSION,
    ),
    sweepMinutes: normalizePositiveInteger(
      raw?.sweepMinutes,
      DEFAULT_BROWSER_TAB_CLEANUP_SWEEP_MINUTES,
    ),
  };
}

function resolveCdpPortRangeStart(
  rawStart: number | undefined,
  fallbackStart: number,
  rangeSpan: number,
): number {
  const start =
    typeof rawStart === "number" && Number.isFinite(rawStart)
      ? Math.floor(rawStart)
      : fallbackStart;
  if (start < 1 || start > 65535) {
    throw new Error(`browser.cdpPortRangeStart must be between 1 and 65535, got: ${start}`);
  }
  const maxStart = 65535 - rangeSpan;
  if (start > maxStart) {
    throw new Error(
      `browser.cdpPortRangeStart (${start}) is too high for a ${rangeSpan + 1}-port range; max is ${maxStart}.`,
    );
  }
  return start;
}

const normalizeStringList = normalizeOptionalTrimmedStringList;

function resolveBrowserSsrFPolicy(cfg: BrowserConfig | undefined): SsrFPolicy | undefined {
  const rawPolicy = cfg?.ssrfPolicy as BrowserSsrFPolicyCompat | undefined;
  const allowPrivateNetwork = rawPolicy?.allowPrivateNetwork;
  const dangerouslyAllowPrivateNetwork = rawPolicy?.dangerouslyAllowPrivateNetwork;
  const allowedHostnames = normalizeStringList(rawPolicy?.allowedHostnames);
  const hostnameAllowlist = normalizeStringList(rawPolicy?.hostnameAllowlist);
  const hasExplicitPrivateSetting =
    allowPrivateNetwork !== undefined || dangerouslyAllowPrivateNetwork !== undefined;
  const resolvedAllowPrivateNetwork =
    dangerouslyAllowPrivateNetwork === true || allowPrivateNetwork === true;

  if (
    !resolvedAllowPrivateNetwork &&
    !hasExplicitPrivateSetting &&
    !allowedHostnames &&
    !hostnameAllowlist
  ) {
    // Keep the default policy object present so CDP guards still enforce
    // fail-closed private-network checks on unconfigured installs.
    return {};
  }

  return {
    ...(resolvedAllowPrivateNetwork ||
    dangerouslyAllowPrivateNetwork === false ||
    allowPrivateNetwork === false
      ? { dangerouslyAllowPrivateNetwork: resolvedAllowPrivateNetwork }
      : {}),
    ...(allowedHostnames ? { allowedHostnames } : {}),
    ...(hostnameAllowlist ? { hostnameAllowlist } : {}),
  };
}

function ensureDefaultProfile(
  profiles: Record<string, BrowserProfileConfig> | undefined,
  defaultColor: string,
  legacyCdpPort?: number,
  derivedDefaultCdpPort?: number,
  legacyCdpUrl?: string,
): Record<string, BrowserProfileConfig> {
  const result = { ...profiles };
  if (!result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]) {
    result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME] = {
      cdpPort: legacyCdpPort ?? derivedDefaultCdpPort ?? DEFAULT_BROWSER_CDP_PORT_RANGE_START,
      color: defaultColor,
      ...(legacyCdpUrl ? { cdpUrl: legacyCdpUrl } : {}),
    };
  }
  return result;
}

function ensureDefaultUserBrowserProfile(
  profiles: Record<string, BrowserProfileConfig>,
): Record<string, BrowserProfileConfig> {
  const result = { ...profiles };
  if (result.user) {
    return result;
  }
  result.user = {
    driver: "existing-session",
    attachOnly: true,
    color: "#00AA00",
  };
  return result;
}

export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
  rootConfig?: OpenClawConfig,
): ResolvedBrowserConfig {
  const enabled = cfg?.enabled ?? DEFAULT_OPENCLAW_BROWSER_ENABLED;
  const evaluateEnabled = cfg?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;
  const gatewayPort = resolveGatewayPort(rootConfig);
  const controlPort = deriveDefaultBrowserControlPort(gatewayPort ?? DEFAULT_BROWSER_CONTROL_PORT);
  const defaultColor = normalizeHexColor(cfg?.color);
  const remoteCdpTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpTimeoutMs, 1500);
  const remoteCdpHandshakeTimeoutMs = normalizeTimeoutMs(
    cfg?.remoteCdpHandshakeTimeoutMs,
    Math.max(2000, remoteCdpTimeoutMs * 2),
  );
  const localLaunchTimeoutMs = normalizeStartupTimeoutMs(
    cfg?.localLaunchTimeoutMs,
    DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS,
  );
  const localCdpReadyTimeoutMs = normalizeStartupTimeoutMs(
    cfg?.localCdpReadyTimeoutMs,
    DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS,
  );
  const actionTimeoutMs = normalizeTimeoutMs(
    cfg?.actionTimeoutMs,
    DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  );

  const derivedCdpRange = deriveDefaultBrowserCdpPortRange(controlPort);
  const cdpRangeSpan = derivedCdpRange.end - derivedCdpRange.start;
  const cdpPortRangeStart = resolveCdpPortRangeStart(
    cfg?.cdpPortRangeStart,
    derivedCdpRange.start,
    cdpRangeSpan,
  );
  const cdpPortRangeEnd = cdpPortRangeStart + cdpRangeSpan;

  const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
  let cdpInfo:
    | {
        parsed: URL;
        port: number;
        normalized: string;
      }
    | undefined;
  if (rawCdpUrl) {
    cdpInfo = parseBrowserHttpUrl(rawCdpUrl, "browser.cdpUrl");
  } else {
    const derivedPort = controlPort + 1;
    if (derivedPort > 65535) {
      throw new Error(
        `Derived CDP port (${derivedPort}) is too high; check gateway port configuration.`,
      );
    }
    const derived = new URL(`http://127.0.0.1:${derivedPort}`);
    cdpInfo = {
      parsed: derived,
      port: derivedPort,
      normalized: derived.toString().replace(/\/$/, ""),
    };
  }

  const headless = cfg?.headless === true;
  const headlessSource = typeof cfg?.headless === "boolean" ? "config" : "default";
  const noSandbox = cfg?.noSandbox === true;
  const attachOnly = cfg?.attachOnly === true;
  const executablePath = normalizeExecutablePath(cfg?.executablePath);
  const defaultProfileFromConfig = normalizeOptionalString(cfg?.defaultProfile);

  const legacyCdpPort = rawCdpUrl ? cdpInfo.port : undefined;
  const isWsUrl = cdpInfo.parsed.protocol === "ws:" || cdpInfo.parsed.protocol === "wss:";
  const legacyCdpUrl = rawCdpUrl && isWsUrl ? cdpInfo.normalized : undefined;
  const profiles = ensureDefaultUserBrowserProfile(
    ensureDefaultProfile(
      cfg?.profiles,
      defaultColor,
      legacyCdpPort,
      cdpPortRangeStart,
      legacyCdpUrl,
    ),
  );
  const cdpProtocol = cdpInfo.parsed.protocol === "https:" ? "https" : "http";

  const defaultProfile =
    defaultProfileFromConfig ??
    (profiles[DEFAULT_BROWSER_DEFAULT_PROFILE_NAME]
      ? DEFAULT_BROWSER_DEFAULT_PROFILE_NAME
      : profiles[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]
        ? DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME
        : "user");

  const extraArgs = Array.isArray(cfg?.extraArgs)
    ? cfg.extraArgs.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];

  return {
    enabled,
    evaluateEnabled,
    controlPort,
    cdpPortRangeStart,
    cdpPortRangeEnd,
    cdpProtocol,
    cdpHost: cdpInfo.parsed.hostname,
    cdpIsLoopback: isLoopbackHost(cdpInfo.parsed.hostname),
    remoteCdpTimeoutMs,
    remoteCdpHandshakeTimeoutMs,
    localLaunchTimeoutMs,
    localCdpReadyTimeoutMs,
    actionTimeoutMs,
    color: defaultColor,
    executablePath,
    headless,
    headlessSource,
    noSandbox,
    attachOnly,
    defaultProfile,
    profiles,
    tabCleanup: resolveBrowserTabCleanupConfig(cfg),
    ssrfPolicy: resolveBrowserSsrFPolicy(cfg),
    extraArgs,
  };
}

export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  const profile = resolved.profiles[profileName];
  if (!profile) {
    return null;
  }

  const rawProfileUrl = profile.cdpUrl?.trim() ?? "";
  let cdpHost = resolved.cdpHost;
  let cdpPort = profile.cdpPort ?? 0;
  let cdpUrl = "";
  const driver = profile.driver === "existing-session" ? "existing-session" : "openclaw";
  const headless = profile.headless ?? resolved.headless;
  const headlessSource =
    typeof profile.headless === "boolean" ? "profile" : resolved.headlessSource;
  const executablePath = normalizeExecutablePath(profile.executablePath) ?? resolved.executablePath;

  if (driver === "existing-session") {
    const existingSessionCdp = normalizeExistingSessionCdpUrl(rawProfileUrl, profileName);
    return {
      name: profileName,
      cdpPort: 0,
      cdpUrl: existingSessionCdp?.cdpUrl ?? "",
      cdpHost: existingSessionCdp?.cdpHost ?? "",
      cdpIsLoopback: existingSessionCdp?.cdpIsLoopback ?? true,
      userDataDir: resolveUserPath(profile.userDataDir?.trim() || "") || undefined,
      mcpCommand: normalizeOptionalString(profile.mcpCommand),
      mcpArgs: normalizeStringList(profile.mcpArgs) ?? undefined,
      color: profile.color,
      driver,
      executablePath,
      headless,
      headlessSource,
      attachOnly: true,
    };
  }

  const hasStaleWsPath =
    rawProfileUrl !== "" &&
    cdpPort > 0 &&
    /^wss?:\/\//i.test(rawProfileUrl) &&
    /\/devtools\/browser\//i.test(rawProfileUrl);

  if (hasStaleWsPath) {
    const parsed = new URL(rawProfileUrl);
    cdpHost = parsed.hostname;
    cdpUrl = `${resolved.cdpProtocol}://${cdpHost}:${cdpPort}`;
  } else if (rawProfileUrl) {
    const parsed = parseBrowserHttpUrl(rawProfileUrl, `browser.profiles.${profileName}.cdpUrl`);
    cdpHost = parsed.parsed.hostname;
    cdpPort = parsed.port;
    cdpUrl = parsed.normalized;
  } else if (cdpPort) {
    cdpUrl = `${resolved.cdpProtocol}://${resolved.cdpHost}:${cdpPort}`;
  } else {
    throw new Error(`Profile "${profileName}" must define cdpPort or cdpUrl.`);
  }

  return {
    name: profileName,
    cdpPort,
    cdpUrl,
    cdpHost,
    cdpIsLoopback: isLoopbackHost(cdpHost),
    color: profile.color,
    driver,
    executablePath,
    headless,
    headlessSource,
    attachOnly: profile.attachOnly ?? resolved.attachOnly,
  };
}

export function resolveManagedBrowserHeadlessMode(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  params: ManagedBrowserHeadlessOptions = {},
): ManagedBrowserHeadlessMode {
  if (!isLocalManagedProfile(profile)) {
    return { headless: profile.headless, source: profile.headlessSource ?? "default" };
  }

  if (typeof params.headlessOverride === "boolean") {
    return { headless: params.headlessOverride, source: "request" };
  }

  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const envHeadless = parseBooleanValue(env[OPENCLAW_BROWSER_HEADLESS_ENV]);
  if (envHeadless !== undefined) {
    return { headless: envHeadless, source: "env" };
  }

  const profileHeadlessSource = profile.headlessSource ?? "default";
  if (profileHeadlessSource !== "default") {
    return { headless: profile.headless, source: profileHeadlessSource };
  }

  if (platform === "linux" && !hasLinuxDisplay(env)) {
    return { headless: true, source: "linux-display-fallback" };
  }

  return { headless: resolved.headless, source: "default" };
}

export function getManagedBrowserMissingDisplayError(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  params: ManagedBrowserHeadlessOptions = {},
): string | null {
  if (!isLocalManagedProfile(profile)) {
    return null;
  }
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  if (platform !== "linux" || hasLinuxDisplay(env)) {
    return null;
  }

  const mode = resolveManagedBrowserHeadlessMode(resolved, profile, { env, platform });
  if (mode.headless) {
    return null;
  }

  const sourceHint =
    mode.source === "request"
      ? "request override"
      : mode.source === "env"
        ? `${OPENCLAW_BROWSER_HEADLESS_ENV}=0`
        : mode.source === "profile"
          ? `browser.profiles.${profile.name}.headless=false`
          : "browser.headless=false";
  return (
    `Headed browser start requested for profile "${profile.name}" via ${sourceHint}, ` +
    "but no Linux display server was detected ($DISPLAY/$WAYLAND_DISPLAY unset). " +
    `Set ${OPENCLAW_BROWSER_HEADLESS_ENV}=1, remove the headed override, or launch under Xvfb.`
  );
}

export function shouldStartLocalBrowserServer(_resolved: unknown) {
  return true;
}
