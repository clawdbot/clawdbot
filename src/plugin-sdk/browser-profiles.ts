/**
 * Public SDK facade for browser profile defaults and activated profile resolution.
 */
import path from "node:path";
import type { BrowserConfig } from "../config/types.browser.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./browser-types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";
export type {
  ResolvedBrowserConfig,
  ResolvedBrowserProfile,
  ResolvedBrowserTabCleanupConfig,
} from "./browser-types.js";

/** Default global browser plugin enabled state. */
export const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
/** Default setting for model/tool browser page evaluation. */
export const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
/** Default browser profile accent color shown in UI surfaces. */
export const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
/** Default OpenClaw-managed browser profile name. */
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
/** Default browser profile selected when config omits a profile name. */
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
/** Default timeout for browser actions issued through the browser plugin. */
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
/** Default maximum AI snapshot text captured from browser pages. */
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 80_000;
/** Default upload staging directory used by browser-backed file uploads. */
export const DEFAULT_UPLOAD_DIR = path.join(resolvePreferredOpenClawTmpDir(), "uploads");

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
