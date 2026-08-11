/**
 * Browser default configuration constants.
 *
 * Shared defaults for config resolution, tool schemas, managed Chrome launch,
 * tab cleanup, screenshots, and AI snapshot sizing.
 */
/** Default enabled state for the browser plugin. */
export const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
/** Default JavaScript evaluation permission for managed browser actions. */
export const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
/** Default color for the managed OpenClaw browser profile. */
export const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
/** Default managed profile name shown to users. */
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
/** Default browser profile selected when no profile is requested. */
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
/** Default timeout for browser action execution. */
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
/** Default timeout for browser download capture. */
export const DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Default launch readiness window for managed local Chrome. */
export const DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS = 15_000;
/** Default CDP readiness window after managed Chrome launch. */
export const DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS = 8_000;
/** Default timeout for screenshot capture. */
export const DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS = 20_000;
/** Default timeout for snapshot capture. */
export const DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS = 20_000;
/** Default idle age before session tab cleanup can close tabs. */
export const DEFAULT_BROWSER_TAB_CLEANUP_IDLE_MINUTES = 120;
/** Default maximum tracked tabs kept per session. */
export const DEFAULT_BROWSER_TAB_CLEANUP_MAX_TABS_PER_SESSION = 8;
/** Default interval for tab cleanup sweeps. */
export const DEFAULT_BROWSER_TAB_CLEANUP_SWEEP_MINUTES = 5;
/**
 * Age after which a tracked tab whose browser stays unreachable is retired
 * instead of retried forever. Rows only reach this branch when cleanup already
 * failed to prove ownership, and a browser that returns after this long almost
 * always carries a fresh instance fingerprint, which retires the row anyway.
 */
export const BROWSER_TAB_UNREACHABLE_RETIRE_MS = 24 * 60 * 60 * 1_000;
/** Default maximum AI snapshot text size. */
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 40_000;
/** Default maximum AI snapshot text size in efficient mode. */
export const DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS = 8_000;
/** Default maximum AI snapshot depth in efficient mode. */
export const DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH = 6;
