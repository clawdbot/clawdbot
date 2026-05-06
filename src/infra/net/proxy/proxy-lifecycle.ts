/**
 * High-level lifecycle management for OpenClaw's operator-managed network
 * proxy routing.
 *
 * OpenClaw does not spawn or configure the filtering proxy. When enabled, it
 * routes process-wide HTTP clients through the configured forward proxy URL and
 * restores the previous process state on shutdown.
 */

import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { bootstrap as bootstrapGlobalAgent } from "global-agent";
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
  /** Alias kept for CLI cleanup tests and logs. */
  injectedProxyUrl: string;
  /** Original proxy-related environment values, restored on stop/crash. */
  envSnapshot: ProxyEnvSnapshot;
  /** Restore process-wide proxy state. */
  stop: () => Promise<void>;
  /** Synchronously restore process-wide proxy state during hard process exit. */
  kill: (signal?: NodeJS.Signals) => void;
};

const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const GLOBAL_AGENT_PROXY_KEYS = ["GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY"] as const;
const GLOBAL_AGENT_FORCE_KEYS = ["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] as const;
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY", "GLOBAL_AGENT_NO_PROXY"] as const;
const PROXY_ACTIVE_KEYS = ["OPENCLAW_PROXY_ACTIVE", "OPENCLAW_PROXY_LOOPBACK_MODE"] as const;
const ALL_PROXY_ENV_KEYS = [
  ...PROXY_ENV_KEYS,
  ...GLOBAL_AGENT_PROXY_KEYS,
  ...GLOBAL_AGENT_FORCE_KEYS,
  ...NO_PROXY_ENV_KEYS,
  ...PROXY_ACTIVE_KEYS,
] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;
type NodeHttpStackSnapshot = {
  httpRequest: typeof http.request;
  httpGet: typeof http.get;
  httpGlobalAgent: typeof http.globalAgent;
  httpsRequest: typeof https.request;
  httpsGet: typeof https.get;
  httpsGlobalAgent: typeof https.globalAgent;
  hadGlobalAgent: boolean;
  globalAgent: unknown;
};
type GlobalAgentConnectConfiguration = Record<string, unknown> & {
  host: string;
  tls: Record<string, unknown>;
};
type GlobalAgentCreateConnection = typeof https.globalAgent.createConnection;
type GlobalAgentCreateConnectionConfiguration = Parameters<GlobalAgentCreateConnection>[0];
type GlobalAgentCreateConnectionCallback = Parameters<GlobalAgentCreateConnection>[1];
type GlobalAgentCreateConnectionResult = ReturnType<GlobalAgentCreateConnection>;
type GlobalAgentHttpsAgent = {
  createConnection: GlobalAgentCreateConnection;
};

let globalAgentBootstrapped = false;
let nodeHttpStackSnapshot: NodeHttpStackSnapshot | null = null;
let baseProxyEnvSnapshot: ProxyEnvSnapshot | null = null;
let patchedGlobalAgentHttpsAgents = new WeakSet<object>();

export function _resetGlobalAgentBootstrapForTests(): void {
  globalAgentBootstrapped = false;
  nodeHttpStackSnapshot = null;
  baseProxyEnvSnapshot = null;
  patchedGlobalAgentHttpsAgents = new WeakSet<object>();
}

function captureProxyEnv(): ProxyEnvSnapshot {
  return {
    http_proxy: process.env["http_proxy"],
    https_proxy: process.env["https_proxy"],
    HTTP_PROXY: process.env["HTTP_PROXY"],
    HTTPS_PROXY: process.env["HTTPS_PROXY"],
    GLOBAL_AGENT_HTTP_PROXY: process.env["GLOBAL_AGENT_HTTP_PROXY"],
    GLOBAL_AGENT_HTTPS_PROXY: process.env["GLOBAL_AGENT_HTTPS_PROXY"],
    GLOBAL_AGENT_FORCE_GLOBAL_AGENT: process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"],
    no_proxy: process.env["no_proxy"],
    NO_PROXY: process.env["NO_PROXY"],
    GLOBAL_AGENT_NO_PROXY: process.env["GLOBAL_AGENT_NO_PROXY"],
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
  for (const key of GLOBAL_AGENT_PROXY_KEYS) {
    process.env[key] = proxyUrl;
  }
  process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] = "true";
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

function restoreGlobalAgentRuntime(snapshot: ProxyEnvSnapshot): void {
  if (
    typeof global === "undefined" ||
    (global as Record<string, unknown>)["GLOBAL_AGENT"] == null
  ) {
    return;
  }
  const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
  agent["HTTP_PROXY"] = snapshot["GLOBAL_AGENT_HTTP_PROXY"] ?? "";
  agent["HTTPS_PROXY"] = snapshot["GLOBAL_AGENT_HTTPS_PROXY"] ?? "";
  agent["NO_PROXY"] = snapshot["GLOBAL_AGENT_NO_PROXY"] ?? null;
}

function captureNodeHttpStack(): NodeHttpStackSnapshot {
  const globalRecord = global as Record<string, unknown>;
  return {
    httpRequest: http.request,
    httpGet: http.get,
    httpGlobalAgent: http.globalAgent,
    httpsRequest: https.request,
    httpsGet: https.get,
    httpsGlobalAgent: https.globalAgent,
    hadGlobalAgent: Object.hasOwn(globalRecord, "GLOBAL_AGENT"),
    globalAgent: globalRecord["GLOBAL_AGENT"],
  };
}

function restoreNodeHttpStack(): void {
  const snapshot = nodeHttpStackSnapshot;
  if (!snapshot) {
    return;
  }
  http.request = snapshot.httpRequest;
  http.get = snapshot.httpGet;
  http.globalAgent = snapshot.httpGlobalAgent;
  https.request = snapshot.httpsRequest;
  https.get = snapshot.httpsGet;
  https.globalAgent = snapshot.httpsGlobalAgent;
  const globalRecord = global as Record<string, unknown>;
  if (snapshot.hadGlobalAgent) {
    globalRecord["GLOBAL_AGENT"] = snapshot.globalAgent;
  } else {
    delete globalRecord["GLOBAL_AGENT"];
  }
  nodeHttpStackSnapshot = null;
  globalAgentBootstrapped = false;
}

function bootstrapNodeHttpStack(proxyUrl: string): void {
  if (!globalAgentBootstrapped) {
    nodeHttpStackSnapshot = captureNodeHttpStack();
    bootstrapGlobalAgent();
    patchGlobalAgentHttpsConnectTlsTargetHost();
    globalAgentBootstrapped = true;
  }

  if (
    typeof global !== "undefined" &&
    (global as Record<string, unknown>)["GLOBAL_AGENT"] != null
  ) {
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    agent["HTTP_PROXY"] = proxyUrl;
    agent["HTTPS_PROXY"] = proxyUrl;
    agent["NO_PROXY"] = process.env["GLOBAL_AGENT_NO_PROXY"];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGlobalAgentConnectConfiguration(
  value: unknown,
): value is GlobalAgentConnectConfiguration {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["host"] === "string" && isRecord(value["tls"]);
}

function isGlobalAgentHttpsAgent(value: unknown): value is GlobalAgentHttpsAgent {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["createConnection"] === "function";
}

function withTlsTargetHost(
  configuration: GlobalAgentCreateConnectionConfiguration,
): GlobalAgentCreateConnectionConfiguration {
  if (!isGlobalAgentConnectConfiguration(configuration)) {
    return configuration;
  }

  // Compatibility shim for https://github.com/gajus/global-agent/issues/83.
  // global-agent@4.1.3 can CONNECT to the right host while leaving Node TLS
  // certificate validation pointed at the proxy socket host. Keep this until
  // upstream carries the CONNECT target host through to tls.connect().
  const tlsOptions: Record<string, unknown> = {
    ...configuration.tls,
    host: configuration.host,
  };
  if (tlsOptions["servername"] === undefined && isIP(configuration.host) === 0) {
    tlsOptions["servername"] = configuration.host;
  }
  return {
    ...configuration,
    tls: tlsOptions,
  } as GlobalAgentCreateConnectionConfiguration;
}

function patchGlobalAgentHttpsConnectTlsTargetHost(): void {
  const agent = https.globalAgent;
  if (!isGlobalAgentHttpsAgent(agent) || patchedGlobalAgentHttpsAgents.has(agent)) {
    return;
  }

  const createConnection = agent.createConnection.bind(agent);
  agent.createConnection = function createConnectionWithTlsTargetHost(
    this: unknown,
    configuration: GlobalAgentCreateConnectionConfiguration,
    callback?: GlobalAgentCreateConnectionCallback,
  ): GlobalAgentCreateConnectionResult {
    return createConnection(withTlsTargetHost(configuration), callback);
  };
  patchedGlobalAgentHttpsAgents.add(agent);
}

function resetUndiciDispatcherForProxyLifecycle(): void {
  try {
    forceResetGlobalDispatcher();
  } catch (err) {
    logWarn(`proxy: failed to reset undici dispatcher: ${String(err)}`);
  }
}

function restoreGlobalAgentRuntimeForProxyLifecycle(snapshot: ProxyEnvSnapshot): void {
  try {
    restoreGlobalAgentRuntime(snapshot);
  } catch (err) {
    logWarn(`proxy: failed to reset global-agent: ${String(err)}`);
  }
}

function restoreNodeHttpStackForProxyLifecycle(): void {
  try {
    restoreNodeHttpStack();
  } catch (err) {
    logWarn(`proxy: failed to restore node HTTP stack: ${String(err)}`);
  }
}

function restoreInactiveProxyRuntime(snapshot: ProxyEnvSnapshot): void {
  restoreProxyEnv(snapshot);
  resetUndiciDispatcherForProxyLifecycle();
  restoreGlobalAgentRuntimeForProxyLifecycle(snapshot);
  restoreNodeHttpStackForProxyLifecycle();
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
  const proxyUrl = process.env["GLOBAL_AGENT_HTTP_PROXY"] ?? process.env["HTTP_PROXY"];
  if (!proxyUrl || !isSupportedProxyUrl(proxyUrl)) {
    return;
  }
  bootstrapNodeHttpStack(proxyUrl);
  forceResetGlobalDispatcher();
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
      injectedProxyUrl: proxyUrl,
      envSnapshot: baseProxyEnvSnapshot ?? captureProxyEnv(),
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
  let injectedEnvSnapshot = captureProxyEnv();
  let registration: ActiveManagedProxyRegistration | null = null;

  try {
    injectedEnvSnapshot = injectProxyEnv(proxyUrl, loopbackMode);
    forceResetGlobalDispatcher();
    bootstrapNodeHttpStack(proxyUrl);
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
    injectedProxyUrl: proxyUrl,
    envSnapshot: injectedEnvSnapshot,
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

function getGatewayControlPlaneNoProxyAuthority(value: string): string | null {
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

function unbracketHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isGatewayControlPlaneIpv6LoopbackUrl(value: string): boolean {
  const url = parseGatewayControlPlaneUrl(value);
  if (
    url === null ||
    !isGatewayControlPlaneProtocol(url.protocol) ||
    !isGatewayControlPlaneLoopbackHost(url.hostname)
  ) {
    return false;
  }
  return isIP(unbracketHost(url.hostname)) === 6;
}

function readGlobalAgentNoProxy(): string {
  const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"];
  if (!isRecord(agent)) {
    return "";
  }
  return typeof agent["NO_PROXY"] === "string" ? agent["NO_PROXY"] : "";
}

function writeGlobalAgentNoProxy(value: string): void {
  const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"];
  if (isRecord(agent)) {
    agent["NO_PROXY"] = value === "" ? null : value;
  }
}

function appendNoProxyAuthority(noProxy: string, authority: string): string {
  const entries = noProxy.split(/[\s,]+/).filter(Boolean);
  return entries.includes(authority) ? noProxy : [...entries, authority].join(",");
}

function disableGlobalAgentProxyForIpv6GatewayLoopback(url: string): (() => void) | undefined {
  if (
    getActiveManagedProxyLoopbackMode() !== "gateway-only" ||
    !isGatewayControlPlaneIpv6LoopbackUrl(url)
  ) {
    return undefined;
  }
  const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"];
  if (!isRecord(agent)) {
    return undefined;
  }

  const previousHttpProxy = agent["HTTP_PROXY"];
  const previousHttpsProxy = agent["HTTPS_PROXY"];
  agent["HTTP_PROXY"] = null;
  agent["HTTPS_PROXY"] = null;
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    agent["HTTP_PROXY"] = previousHttpProxy;
    agent["HTTPS_PROXY"] = previousHttpsProxy;
  };
}

export function registerManagedProxyGatewayLoopbackNoProxy(url: string): (() => void) | undefined {
  const authority = getGatewayControlPlaneNoProxyAuthority(url);
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

  const previousNoProxy = readGlobalAgentNoProxy();
  writeGlobalAgentNoProxy(appendNoProxyAuthority(previousNoProxy, authority));
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    writeGlobalAgentNoProxy(previousNoProxy);
  };
}

export function withManagedProxyGatewayLoopbackRouting<T>(url: string, run: () => T): T {
  let unregisterNoProxy: (() => void) | undefined;
  let restoreIpv6Bypass: (() => void) | undefined;
  try {
    unregisterNoProxy = registerManagedProxyGatewayLoopbackNoProxy(url);
    restoreIpv6Bypass = disableGlobalAgentProxyForIpv6GatewayLoopback(url);
    return run();
  } finally {
    restoreIpv6Bypass?.();
    unregisterNoProxy?.();
  }
}

function isGatewayControlPlaneLoopbackHost(hostname: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return normalizedHost === "localhost" || isLoopbackIpAddress(hostname);
}
