/** Browser profile config embedded in resolved browser config. */
export type ResolvedBrowserProfileConfig = {
  cdpPort?: number;
  cdpUrl?: string;
  userDataDir?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  driver?: "openclaw" | "clawd" | "existing-session";
  headless?: boolean;
  executablePath?: string;
  attachOnly?: boolean;
  color: string;
};

/** SSRF policy embedded in resolved browser config. */
export type ResolvedBrowserSsrFPolicy = {
  allowPrivateNetwork?: boolean;
  dangerouslyAllowPrivateNetwork?: boolean;
  allowRfc2544BenchmarkRange?: boolean;
  allowIpv6UniqueLocalRange?: boolean;
  allowedHostnames?: string[];
  allowedOrigins?: string[];
  hostnameAllowlist?: string[];
};

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
  profiles: Record<string, ResolvedBrowserProfileConfig>;
  tabCleanup: ResolvedBrowserTabCleanupConfig;
  ssrfPolicy?: ResolvedBrowserSsrFPolicy;
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
