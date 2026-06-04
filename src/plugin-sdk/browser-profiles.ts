/**
 * Public SDK facade for browser profile defaults and activated profile resolution.
 */
import path from "node:path";
import type { BrowserConfig, BrowserProfileConfig, OpenClawConfig } from "../config/config.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
export const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
export const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 80_000;
export const DEFAULT_UPLOAD_DIR = path.join(resolvePreferredOpenClawTmpDir(), "uploads");

/** Resolved browser tab cleanup settings after defaults and config are applied. */
export type ResolvedBrowserTabCleanupConfig = {
  enabled: boolean;
  idleMinutes: number;
  maxTabsPerSession: number;
  sweepMinutes: number;
};

/** Fully resolved browser plugin config used by browser runtime callers. */
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
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
  tabCleanup: ResolvedBrowserTabCleanupConfig;
  ssrfPolicy?: SsrFPolicy;
  extraArgs: string[];
};

/** One resolved browser profile target including CDP endpoint and launch mode. */
export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  userDataDir?: string;
  color: string;
  driver: "openclaw" | "existing-session";
  headless?: boolean;
  attachOnly: boolean;
};

type BrowserProfilesSurface = {
  resolveBrowserConfig: (
    cfg: BrowserConfig | undefined,
    rootConfig?: OpenClawConfig,
  ) => ResolvedBrowserConfig;
  resolveProfile: (
    resolved: ResolvedBrowserConfig,
    profileName: string,
  ) => ResolvedBrowserProfile | null;
};

let cachedBrowserProfilesSurface: BrowserProfilesSurface | undefined;

function loadBrowserProfilesSurface(): BrowserProfilesSurface {
  cachedBrowserProfilesSurface ??= loadBundledPluginPublicSurfaceModuleSync<BrowserProfilesSurface>(
    {
      dirName: "browser",
      artifactBasename: "browser-profiles.js",
    },
  );
  return cachedBrowserProfilesSurface;
}

/** Resolves browser config through the activated bundled browser profile facade. */
export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
  rootConfig?: OpenClawConfig,
): ResolvedBrowserConfig {
  return loadBrowserProfilesSurface().resolveBrowserConfig(cfg, rootConfig);
}

/** Resolves one named browser profile from an already resolved browser config. */
export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  return loadBrowserProfilesSurface().resolveProfile(resolved, profileName);
}
