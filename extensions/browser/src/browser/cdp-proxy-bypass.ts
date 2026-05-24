/**
 * Proxy bypass for CDP (Chrome DevTools Protocol) localhost connections.
 *
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables are set,
 * CDP connections to localhost/127.0.0.1 can be incorrectly routed through
 * the proxy, causing browser control to fail.
 *
 * @see https://github.com/nicepkg/openclaw/issues/31219
 */
import http from "node:http";
import https from "node:https";
import { registerManagedProxyBrowserCdpBypass } from "openclaw/plugin-sdk/ssrf-runtime-internal";
import { isLoopbackHost } from "../gateway/net.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";

/** HTTP agent that never uses a proxy — for localhost CDP connections. */
const directHttpAgent = new http.Agent();
const directHttpsAgent = new https.Agent();

/**
 * Returns a plain (non-proxy) agent for WebSocket or HTTP connections
 * when the target is a loopback address. Returns `undefined` otherwise
 * so callers fall through to their default behaviour.
 */
export function getDirectAgentForCdp(url: string): http.Agent | https.Agent | undefined {
  try {
    const parsed = new URL(url);
    if (isLoopbackHost(parsed.hostname)) {
      return parsed.protocol === "https:" || parsed.protocol === "wss:"
        ? directHttpsAgent
        : directHttpAgent;
    }
  } catch {
    // not a valid URL — let caller handle it
  }
  return undefined;
}

/**
 * Returns `true` when any proxy-related env var is set that could
 * interfere with loopback connections.
 */
export function hasProxyEnv(): boolean {
  return hasProxyEnvConfigured();
}

const LOOPBACK_ENTRIES = "localhost,127.0.0.1,[::1]";

function noProxyValueCoversLocalhost(value: string | undefined): boolean {
  const entries = new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return entries.has("localhost") && entries.has("127.0.0.1") && entries.has("[::1]");
}

function noProxyAlreadyCoversLocalhost(): boolean {
  return (
    noProxyValueCoversLocalhost(process.env.NO_PROXY) &&
    noProxyValueCoversLocalhost(process.env.no_proxy)
  );
}

function appendLoopbackEntries(value: string | undefined): string {
  return value ? `${value},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
}

export async function withNoProxyForLocalhost<T>(fn: () => Promise<T>): Promise<T> {
  return await withNoProxyForCdpUrl("http://127.0.0.1", fn);
}

function isLoopbackCdpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

type NoProxySnapshot = {
  noProxy: string | undefined;
  noProxyLower: string | undefined;
  appliedNoProxy: string;
  appliedNoProxyLower: string;
};

class NoProxyLeaseManager {
  private leaseCount = 0;
  private snapshot: NoProxySnapshot | null = null;

  acquire(url: string): (() => void) | null {
    if (!isLoopbackCdpUrl(url) || !hasProxyEnv()) {
      return null;
    }

    if (this.leaseCount === 0 && !noProxyAlreadyCoversLocalhost()) {
      const noProxy = process.env.NO_PROXY;
      const noProxyLower = process.env.no_proxy;
      const appliedNoProxy = appendLoopbackEntries(noProxy || noProxyLower);
      const appliedNoProxyLower = appendLoopbackEntries(noProxyLower || noProxy);
      process.env.NO_PROXY = appliedNoProxy;
      process.env.no_proxy = appliedNoProxyLower;
      this.snapshot = { noProxy, noProxyLower, appliedNoProxy, appliedNoProxyLower };
    }

    this.leaseCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release();
    };
  }

  private release() {
    if (this.leaseCount <= 0) {
      return;
    }
    this.leaseCount -= 1;
    if (this.leaseCount > 0 || !this.snapshot) {
      return;
    }

    const { noProxy, noProxyLower, appliedNoProxy, appliedNoProxyLower } = this.snapshot;
    const currentNoProxy = process.env.NO_PROXY;
    const currentNoProxyLower = process.env.no_proxy;
    if (currentNoProxy === appliedNoProxy) {
      if (noProxy !== undefined) {
        process.env.NO_PROXY = noProxy;
      } else {
        delete process.env.NO_PROXY;
      }
    }
    if (currentNoProxyLower === appliedNoProxyLower) {
      if (noProxyLower !== undefined) {
        process.env.no_proxy = noProxyLower;
      } else {
        delete process.env.no_proxy;
      }
    }

    this.snapshot = null;
  }
}

const noProxyLeaseManager = new NoProxyLeaseManager();

/**
 * Scoped NO_PROXY bypass for loopback CDP URLs.
 *
 * This wrapper only mutates env vars for loopback destinations. On restore,
 * it avoids clobbering external NO_PROXY changes that happened while calls
 * were in-flight.
 */
export async function withNoProxyForCdpUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const release = noProxyLeaseManager.acquire(url);
  try {
    return await fn();
  } finally {
    release?.();
  }
}

/**
 * Scoped managed-proxy bypass for the exact CDP URL about to be used.
 *
 * Proxyline dynamic bypass registrations are exact URL matches, so callers
 * must register the concrete `/json/version` or `ws://.../devtools/...` URL
 * rather than a CDP base URL.
 */
export function withManagedProxyForCdpUrl<T>(url: string, fn: () => T): T {
  const release = registerManagedProxyBrowserCdpBypass(url);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    release?.();
    throw err;
  }

  const maybeThenable = result as unknown;
  if (
    typeof maybeThenable === "object" &&
    maybeThenable !== null &&
    "finally" in maybeThenable &&
    typeof maybeThenable.finally === "function"
  ) {
    return maybeThenable.finally(() => release?.()) as T;
  }
  release?.();
  return result;
}

/**
 * Validate managed-proxy loopback policy without keeping a long-lived bypass.
 * Exact CDP request sites install their own scoped bypasses.
 */
export function assertManagedProxyAllowsCdpUrl(url: string): void {
  withManagedProxyForCdpUrl(url, () => undefined);
}
