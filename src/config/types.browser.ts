export type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */
  cdpPort?: number;
  /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string;
  /** Explicit user data directory for existing-session Chrome MCP attachment. */
  userDataDir?: string;
  /** Override the Chrome MCP command for existing-session profiles. */
  mcpCommand?: string;
  /** Extra Chrome MCP arguments for existing-session profiles. */
  mcpArgs?: string[];
  /** Profile driver (default: openclaw). */
  driver?: "openclaw" | "clawd" | "existing-session";
  /** If true, launch this profile in headless mode. Falls back to browser.headless. */
  headless?: boolean;
  /** Browser executable path for this profile. Falls back to browser.executablePath. */
  executablePath?: string;
  /** If true, never launch a browser for this profile; only attach. Falls back to browser.attachOnly. */
  attachOnly?: boolean;
  /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
export type BrowserSnapshotDefaults = {
  /** Default snapshot mode (applies when mode is not provided). */
  mode?: "efficient";
};
export type BrowserTabCleanupConfig = {
  /** Enable best-effort cleanup for tracked primary-agent browser tabs. Default: true */
  enabled?: boolean;
  /** Close tracked tabs after this many idle minutes. Set 0 to disable idle cleanup. Default: 120 */
  idleMinutes?: number;
  /** Keep at most this many tracked tabs per primary session. Set 0 to disable the cap. Default: 8 */
  maxTabsPerSession?: number;
  /** Cleanup sweep interval in minutes. Default: 5 */
  sweepMinutes?: number;
};
export type BrowserSsrFPolicyConfig = {
  /** If true, permit browser navigation to private/internal networks. Default: true */
  dangerouslyAllowPrivateNetwork?: boolean;
  /**
   * Explicitly allowed hostnames (exact-match), including blocked names like localhost.
   * Example: ["localhost", "metadata.internal"]
   */
  allowedHostnames?: string[];
  /**
   * Hostname allowlist patterns for browser navigation.
   * Supports exact hosts and "*.example.com" wildcard subdomains.
   */
  hostnameAllowlist?: string[];
};
export type BrowserConfig = {
  enabled?: boolean;
  /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
  evaluateEnabled?: boolean;
  /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
  cdpUrl?: string;
  /** Remote CDP HTTP timeout (ms). Default: 1500. */
  remoteCdpTimeoutMs?: number;
  /** Remote CDP WebSocket handshake timeout (ms). Default: max(remoteCdpTimeoutMs * 2, 2000). */
  remoteCdpHandshakeTimeoutMs?: number;
  /** Local managed browser launch discovery timeout (ms). Default: 15000. */
  localLaunchTimeoutMs?: number;
  /** Local managed browser post-launch CDP readiness timeout (ms). Default: 8000. */
  localCdpReadyTimeoutMs?: number;
  /** Default browser act timeout (ms). Default: 60000. */
  actionTimeoutMs?: number;
  /** Accent color for the openclaw browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Override the browser executable path (all platforms). */
  executablePath?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
  /** Starting local CDP port for auto-assigned browser profiles. Default derives from gateway port. */
  cdpPortRangeStart?: number;
  /** Default profile to use when profile param is omitted. Default: "chrome" */
  defaultProfile?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** Default snapshot options (applied by the browser tool/CLI when unset). */
  snapshotDefaults?: BrowserSnapshotDefaults;
  /** Best-effort cleanup policy for tabs opened by primary-agent browser sessions. */
  tabCleanup?: BrowserTabCleanupConfig;
  /** SSRF policy for browser navigation/open-tab operations. */
  ssrfPolicy?: BrowserSsrFPolicyConfig;
  /**
   * Additional Chrome launch arguments.
   * Useful for stealth flags, window size overrides, or custom user-agent strings.
   * Example: ["--window-size=1920,1080", "--disable-infobars"]
   */
  extraArgs?: string[];
};
