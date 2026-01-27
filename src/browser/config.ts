import type { BrowserConfig, BrowserProfileConfig, ClawdbotConfig } from "../config/config.js";
import {
  deriveDefaultBrowserCdpPortRange,
  deriveDefaultBrowserControlPort,
  DEFAULT_BROWSER_CONTROL_PORT,
} from "../config/port-defaults.js";
import { resolveGatewayPort } from "../config/paths.js";
import {
  DEFAULT_CLAWD_BROWSER_COLOR,
  DEFAULT_CLAWD_BROWSER_ENABLED,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_CLAWD_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { CDP_PORT_RANGE_START, getUsedPorts } from "./profiles.js";

export type ResolvedBrowserConfig = {
  enabled: boolean;
  evaluateEnabled: boolean;
  controlPort: number;
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
};

export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  color: string;
  driver: "clawd" | "extension";
};

function isLoopbackHost(host: string) {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "::1" ||
    h === "[::]" ||
    h === "::"
  );
}

function normalizeHexColor(raw: string | undefined) {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_CLAWD_BROWSER_COLOR;
  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return DEFAULT_CLAWD_BROWSER_COLOR;
  return normalized.toUpperCase();
}

function normalizeTimeoutMs(raw: number | undefined, fallback: number) {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return value < 0 ? fallback : value;
}

export function parseHttpUrl(raw: string, label: string) {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be http(s), got: ${parsed.protocol.replace(":", "")}`);
  }

  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  return {
    parsed,
    port,
    normalized: parsed.toString().replace(/\/$/, ""),
  };
}

/**
 * Ensure the default "clawd" profile exists in the profiles map.
 * Auto-creates it with the legacy CDP port (from browser.cdpUrl) or first port if missing.
 */
function ensureDefaultProfile(
  profiles: Record<string, BrowserProfileConfig> | undefined,
  defaultColor: string,
  legacyCdpPort?: number,
  derivedDefaultCdpPort?: number,
): Record<string, BrowserProfileConfig> {
  const result = { ...profiles };
  if (!result[DEFAULT_CLAWD_BROWSER_PROFILE_NAME]) {
    result[DEFAULT_CLAWD_BROWSER_PROFILE_NAME] = {
      cdpPort: legacyCdpPort ?? derivedDefaultCdpPort ?? CDP_PORT_RANGE_START,
      color: defaultColor,
    };
  }
  return result;
}

/**
 * Ensure a built-in "chrome" profile exists for the Chrome extension relay.
 *
 * Note: this is a Clawdbot browser profile (routing config), not a Chrome user profile.
 * It points at the local relay CDP endpoint (controlPort + 1).
 */
function ensureDefaultChromeExtensionProfile(
  profiles: Record<string, BrowserProfileConfig>,
  controlPort: number,
): Record<string, BrowserProfileConfig> {
  const result = { ...profiles };
  if (result.chrome) return result;
  const relayPort = controlPort + 1;
  if (!Number.isFinite(relayPort) || relayPort <= 0 || relayPort > 65535) return result;
  // Avoid adding the built-in profile if the derived relay port is already used by another profile
  // (legacy single-profile configs may use controlPort+1 for clawd CDP).
  if (getUsedPorts(result).has(relayPort)) return result;
  result.chrome = {
    driver: "extension",
    cdpUrl: `http://127.0.0.1:${relayPort}`,
    color: "#00AA00",
  };
  return result;
}
export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
  rootConfig?: ClawdbotConfig,
): ResolvedBrowserConfig {
  const enabled = cfg?.enabled ?? DEFAULT_CLAWD_BROWSER_ENABLED;
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

  const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
  let cdpInfo:
    | {
        parsed: URL;
        port: number;
        normalized: string;
      }
    | undefined;
  if (rawCdpUrl) {
    cdpInfo = parseHttpUrl(rawCdpUrl, "browser.cdpUrl");
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
  const executablePath = cfg?.executablePath?.trim() || undefined;

  const defaultProfileFromConfig = cfg?.defaultProfile?.trim() || undefined;
  // Use legacy cdpUrl port for backward compatibility when no profiles configured
  const legacyCdpPort = rawCdpUrl ? cdpInfo.port : undefined;
  const profiles = ensureDefaultChromeExtensionProfile(
    ensureDefaultProfile(cfg?.profiles, defaultColor, legacyCdpPort, derivedCdpRange.start),
    controlPort,
  );
  const cdpProtocol = cdpInfo.parsed.protocol === "https:" ? "https" : "http";
  const defaultProfile =
    defaultProfileFromConfig ??
    (profiles[DEFAULT_BROWSER_DEFAULT_PROFILE_NAME]
      ? DEFAULT_BROWSER_DEFAULT_PROFILE_NAME
      : DEFAULT_CLAWD_BROWSER_PROFILE_NAME);

  return {
    enabled,
    evaluateEnabled,
    controlPort,
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
  };
}

/**
 * Resolve a profile by name from the config.
 * Returns null if the profile doesn't exist.
 */
export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  const profile = resolved.profiles[profileName];
  if (!profile) return null;

  const rawProfileUrl = profile.cdpUrl?.trim() ?? "";
  let cdpHost = resolved.cdpHost;
  let cdpPort = profile.cdpPort ?? 0;
  let cdpUrl = "";
  const driver = profile.driver === "extension" ? "extension" : "clawd";

  if (rawProfileUrl) {
    const parsed = parseHttpUrl(rawProfileUrl, `browser.profiles.${profileName}.cdpUrl`);
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
  };
}

export function shouldStartLocalBrowserServer(_resolved: ResolvedBrowserConfig) {
  return true;
}
