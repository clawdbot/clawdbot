import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import type { BrowserNavigationProxyMode } from "./navigation-guard.js";

const PROXY_ROUTING_CHROME_ARGS = new Set([
  "--proxy-auto-detect",
  "--proxy-pac-url",
  "--proxy-server",
]);

const PROXY_CONTROL_CHROME_ARGS = new Set(["--no-proxy-server", ...PROXY_ROUTING_CHROME_ARGS]);

export const CHROME_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function chromeArgName(arg: string): string {
  return arg.trim().split("=", 1)[0]?.toLowerCase() ?? "";
}

export function hasChromeProxyControlArg(args: readonly string[]): boolean {
  return args.some((arg) => PROXY_CONTROL_CHROME_ARGS.has(chromeArgName(arg)));
}

export function hasExplicitChromeProxyRoutingArg(args: readonly string[]): boolean {
  return args.some((arg) => PROXY_ROUTING_CHROME_ARGS.has(chromeArgName(arg)));
}

export function omitChromeProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of CHROME_PROXY_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

export function resolveBrowserNavigationProxyMode(params: {
  resolved: Pick<ResolvedBrowserConfig, "extraArgs">;
  profile: Pick<ResolvedBrowserProfile, "cdpIsLoopback" | "driver">;
}): BrowserNavigationProxyMode {
  if (
    params.profile.driver === "openclaw" &&
    params.profile.cdpIsLoopback &&
    hasExplicitChromeProxyRoutingArg(params.resolved.extraArgs)
  ) {
    return "explicit-browser-proxy";
  }
  return "direct";
}
