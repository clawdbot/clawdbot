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
import { parseBrowserHttpUrl, redactCdpUrl, isLoopbackHost } from "./cdp.helpers.js";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { resolveBrowserControlAuth, type BrowserControlAuth } from "./control-auth.js";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";

export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
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
  color: string;
  executablePath?: string;
  headless: boolean;
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
  ssrfPolicy?: SsrFPolicy;
  extraArgs: string[];
};

export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  userDataDir?: string;
  color: string;
  driver: "openclaw" | "existing-session";
  attachOnly: boolean;
};

const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;

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
  const noSandbox = cfg?.noSandbox === true;
  const attachOnly = cfg?.attachOnly === true;
  const executablePath = normalizeOptionalString(cfg?.executablePath);
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
    color: defaultColor,
    executablePath,
    headless,
    noSandbox,
    attachOnly,
    defaultProfile,
    profiles,
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

  if (driver === "existing-session") {
    return {
      name: profileName,
      cdpPort: 0,
      cdpUrl: "",
      cdpHost: "",
      cdpIsLoopback: true,
      userDataDir: resolveUserPath(profile.userDataDir?.trim() || "") || undefined,
      color: profile.color,
      driver,
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
    attachOnly: profile.attachOnly ?? resolved.attachOnly,
  };
}

export function shouldStartLocalBrowserServer(_resolved: unknown) {
  return true;
}
