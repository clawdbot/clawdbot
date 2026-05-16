/**
 * High-level lifecycle management for OpenClaw's operator-managed network
 * proxy routing.
 *
 * OpenClaw does not spawn or configure the filtering proxy. When enabled, it
 * routes process-wide HTTP clients through the configured forward proxy URL and
 * restores the previous process state on shutdown.
 */

import {
  installGlobalProxy,
  type ProxylineHandle,
  type ProxylineUndiciOptions,
} from "@openclaw/proxyline";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";

export type ProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;
import { logInfo, logWarn } from "../../../logger.js";
import { isLoopbackIpAddress } from "../../../shared/net/ip.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import {
  getActiveManagedProxyLoopbackMode,
  getActiveManagedProxyUrl,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
  type ActiveManagedProxyRegistration,
} from "./active-proxy-state.js";

export type ProxyHandle = {
  /** The operator-managed proxy URL injected into process.env. */
  proxyUrl: string;
  /** Restore process-wide proxy state. */
  stop: () => Promise<void>;
  /** Synchronously restore process-wide proxy state during hard process exit. */
  kill: (signal?: NodeJS.Signals) => void;
};

const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY"] as const;
const PROXY_ACTIVE_KEYS = ["OPENCLAW_PROXY_ACTIVE", "OPENCLAW_PROXY_LOOPBACK_MODE"] as const;
const ALL_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, ...NO_PROXY_ENV_KEYS, ...PROXY_ACTIVE_KEYS] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

let baseProxyEnvSnapshot: ProxyEnvSnapshot | null = null;
let proxylineHandle: ProxylineHandle | null = null;
const MANAGED_PROXY_UNDICI_OPTIONS = Object.freeze({
  allowH2: false,
}) satisfies ProxylineUndiciOptions;

export function resetProxyLifecycleForTests(): void {
  baseProxyEnvSnapshot = null;
  proxylineHandle?.stop();
  proxylineHandle = null;
}

function captureProxyEnv(): ProxyEnvSnapshot {
  return {
    http_proxy: process.env["http_proxy"],
    https_proxy: process.env["https_proxy"],
    HTTP_PROXY: process.env["HTTP_PROXY"],
    HTTPS_PROXY: process.env["HTTPS_PROXY"],
    no_proxy: process.env["no_proxy"],
    NO_PROXY: process.env["NO_PROXY"],
    OPENCLAW_PROXY_ACTIVE: process.env["OPENCLAW_PROXY_ACTIVE"],
    OPENCLAW_PROXY_LOOPBACK_MODE: process.env["OPENCLAW_PROXY_LOOPBACK_MODE"],
  };
}

function injectProxyEnv(proxyUrl: string, loopbackMode: ProxyLoopbackMode): ProxyEnvSnapshot {
  const snapshot = captureProxyEnv();
  applyProxyEnv(proxyUrl, loopbackMode);
  return snapshot;
}

function applyProxyEnv(proxyUrl: string, loopbackMode: ProxyLoopbackMode): void {
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
  process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = loopbackMode;
  for (const key of NO_PROXY_ENV_KEYS) {
    process.env[key] = "";
  }
}

function restoreProxyEnv(snapshot: ProxyEnvSnapshot): void {
  for (const key of ALL_PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreInactiveProxyRuntime(snapshot: ProxyEnvSnapshot): void {
  try {
    proxylineHandle?.stop();
  } catch (err) {
    logWarn(`proxy: failed to stop Proxyline: ${String(err)}`);
  }
  proxylineHandle = null;
  restoreProxyEnv(snapshot);
  forceResetGlobalDispatcher();
  ensureInheritedManagedProxyRoutingActive();
}

function restoreAfterFailedProxyActivation(restoreSnapshot: ProxyEnvSnapshot): void {
  restoreInactiveProxyRuntime(restoreSnapshot);
  baseProxyEnvSnapshot = null;
}

function stopActiveProxyRegistration(registration: ActiveManagedProxyRegistration): void {
  if (registration.stopped) {
    return;
  }
  stopActiveManagedProxyRegistration(registration);
  if (getActiveManagedProxyUrl()) {
    return;
  }

  const restoreSnapshot = baseProxyEnvSnapshot ?? captureProxyEnv();
  baseProxyEnvSnapshot = null;
  restoreInactiveProxyRuntime(restoreSnapshot);
}

function isSupportedProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:";
  } catch {
    return false;
  }
}

function resolveProxyUrl(config: ProxyConfig | undefined): string {
  const candidate = config?.proxyUrl?.trim() || process.env["OPENCLAW_PROXY_URL"]?.trim();
  if (!candidate) {
    throw new Error(
      "proxy: enabled but no HTTP proxy URL is configured; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// forward proxy.",
    );
  }
  if (!isSupportedProxyUrl(candidate)) {
    throw new Error(
      "proxy: enabled but proxy URL is invalid; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// forward proxy.",
    );
  }
  return candidate;
}

function redactProxyUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return "<invalid proxy URL>";
  }
}

export function ensureInheritedManagedProxyRoutingActive(): void {
  if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return;
  }
  const proxyUrl = process.env["HTTP_PROXY"];
  if (!proxyUrl || !isSupportedProxyUrl(proxyUrl)) {
    return;
  }
  proxylineHandle = installGlobalProxy({
    mode: "managed",
    proxyUrl,
    ifActive: "reuse-compatible",
    undici: MANAGED_PROXY_UNDICI_OPTIONS,
  });
  forceResetGlobalDispatcher({ preserveProxylineManaged: true });
}

export async function startProxy(config: ProxyConfig | undefined): Promise<ProxyHandle | null> {
  if (config?.enabled !== true) {
    return null;
  }

  const proxyUrl = resolveProxyUrl(config);
  const loopbackMode = config.loopbackMode ?? "gateway-only";
  const activeProxyUrl = getActiveManagedProxyUrl();
  if (activeProxyUrl) {
    const registration = registerActiveManagedProxyUrl(new URL(proxyUrl), loopbackMode);
    const handle: ProxyHandle = {
      proxyUrl,
      stop: async () => {
        stopActiveProxyRegistration(registration);
      },
      kill: () => {
        stopActiveProxyRegistration(registration);
      },
    };
    return handle;
  }
  baseProxyEnvSnapshot ??= captureProxyEnv();
  const lifecycleBaseEnvSnapshot = baseProxyEnvSnapshot;
  let registration: ActiveManagedProxyRegistration | null = null;

  try {
    injectProxyEnv(proxyUrl, loopbackMode);
    proxylineHandle = installGlobalProxy({
      mode: "managed",
      proxyUrl,
      ifActive: "replace",
      undici: MANAGED_PROXY_UNDICI_OPTIONS,
    });
    forceResetGlobalDispatcher({ preserveProxylineManaged: true });
    registration = registerActiveManagedProxyUrl(new URL(proxyUrl), loopbackMode);
  } catch (err) {
    restoreAfterFailedProxyActivation(lifecycleBaseEnvSnapshot);
    throw new Error(`proxy: failed to activate external proxy routing: ${String(err)}`, {
      cause: err,
    });
  }

  logInfo(
    `proxy: routing process HTTP traffic through external proxy ${redactProxyUrlForLog(proxyUrl)}`,
  );

  const handle: ProxyHandle = {
    proxyUrl,
    stop: async () => {
      if (registration) {
        stopActiveProxyRegistration(registration);
      }
    },
    kill: () => {
      if (registration) {
        stopActiveProxyRegistration(registration);
      }
    },
  };

  return handle;
}

export async function stopProxy(handle: ProxyHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  await handle.stop();
}

function parseGatewayControlPlaneUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isGatewayControlPlaneProtocol(protocol: string): boolean {
  return protocol === "ws:" || protocol === "wss:" || protocol === "http:" || protocol === "https:";
}

function getGatewayControlPlaneBypassAuthority(value: string): string | null {
  const url = parseGatewayControlPlaneUrl(value);
  if (
    url === null ||
    !isGatewayControlPlaneProtocol(url.protocol) ||
    !isGatewayControlPlaneLoopbackHost(url.hostname)
  ) {
    return null;
  }
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

export function registerManagedProxyGatewayLoopbackBypass(url: string): (() => void) | undefined {
  const authority = getGatewayControlPlaneBypassAuthority(url);
  if (!authority) {
    return undefined;
  }
  const loopbackMode = getActiveManagedProxyLoopbackMode();
  if (loopbackMode === "block") {
    throw new Error(
      "proxy: Gateway loopback control-plane connections are blocked by proxy.loopbackMode",
    );
  }
  if (loopbackMode === "proxy") {
    return undefined;
  }

  return proxylineHandle?.registerBypass({ url });
}

function isGatewayControlPlaneLoopbackHost(hostname: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return normalizedHost === "localhost" || isLoopbackIpAddress(hostname);
}
