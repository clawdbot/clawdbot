import {
  installGlobalProxy,
  type ProxylineHandle,
  type ProxylineUndiciOptions,
} from "@openclaw/proxyline";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";

export type ProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { logInfo, logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import {
  getActiveManagedProxyLoopbackMode,
  getActiveManagedProxyUrl,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
  type ActiveManagedProxyRegistration,
} from "./active-proxy-state.js";
import {
  loadManagedProxyTlsOptions,
  loadManagedProxyTlsOptionsSync,
  resolveManagedProxyCaFileForUrl,
} from "./proxy-tls.js";

/** Process-wide managed proxy handle returned to CLI/gateway startup owners. */
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
const PROXY_ACTIVE_KEYS = [
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_LOOPBACK_MODE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const ALL_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, ...NO_PROXY_ENV_KEYS, ...PROXY_ACTIVE_KEYS] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

let baseProxyEnvSnapshot: ProxyEnvSnapshot | null = null;
let proxylineHandle: ProxylineHandle | null = null;
const MANAGED_PROXY_UNDICI_OPTIONS = Object.freeze({
  allowH2: false,
}) satisfies ProxylineUndiciOptions;

/** Resets process-wide proxy lifecycle state between tests that share a worker. */
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
    OPENCLAW_PROXY_CA_FILE: process.env["OPENCLAW_PROXY_CA_FILE"],
  };
}

function injectProxyEnv(
  proxyUrl: string,
  loopbackMode: ProxyLoopbackMode,
  proxyCaFile: string | undefined,
): ProxyEnvSnapshot {
  const snapshot = captureProxyEnv();
  applyProxyEnv(proxyUrl, loopbackMode, proxyCaFile);
  return snapshot;
}

function applyProxyEnv(
  proxyUrl: string,
  loopbackMode: ProxyLoopbackMode,
  proxyCaFile: string | undefined,
): void {
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
  process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = loopbackMode;
  if (proxyCaFile) {
    process.env["OPENCLAW_PROXY_CA_FILE"] = proxyCaFile;
  } else {
    delete process.env["OPENCLAW_PROXY_CA_FILE"];
  }
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
  // If this process itself is a child of an active managed proxy, restoring the
  // local lifecycle should keep inherited proxy routing active.
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
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveProxyUrl(config: ProxyConfig | undefined): string {
  const candidate = config?.proxyUrl?.trim() || process.env["OPENCLAW_PROXY_URL"]?.trim();
  if (!candidate) {
    throw new Error(
      "proxy: enabled but no HTTP proxy URL is configured; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// or https:// forward proxy.",
    );
  }
  if (!isSupportedProxyUrl(candidate)) {
    throw new Error(
      "proxy: enabled but proxy URL is invalid; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// or https:// forward proxy.",
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

/** Reinstalls Proxyline routing in child processes that inherited active proxy env. */
export function ensureInheritedManagedProxyRoutingActive(): void {
  if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return;
  }
  const proxyUrl = process.env["HTTP_PROXY"];
  if (!proxyUrl || !isSupportedProxyUrl(proxyUrl)) {
    return;
  }
  const proxyCaFile = resolveManagedProxyCaFileForUrl({
    proxyUrl,
    caFileOverride: process.env["OPENCLAW_PROXY_CA_FILE"],
  });
  const proxyTls = loadManagedProxyTlsOptionsSync(proxyCaFile);
  proxylineHandle = installGlobalProxy({
    mode: "managed",
    proxyUrl,
    ...(proxyTls ? { proxyTls } : {}),
    ifActive: "reuse-compatible",
    undici: MANAGED_PROXY_UNDICI_OPTIONS,
  });
  forceResetGlobalDispatcher({ preserveProxylineManaged: true });
}

/** Starts process-wide managed proxy routing and returns the owner stop handle. */
export async function startProxy(config: ProxyConfig | undefined): Promise<ProxyHandle | null> {
  if (config?.enabled !== true) {
    return null;
  }

  const proxyUrl = resolveProxyUrl(config);
  const loopbackMode = config.loopbackMode ?? "gateway-only";
  const proxyCaFile = resolveManagedProxyCaFileForUrl({ proxyUrl, config });
  const proxyTls = await loadManagedProxyTlsOptions(proxyCaFile);
  const activeProxyUrl = getActiveManagedProxyUrl();
  if (activeProxyUrl) {
    // Nested starts share the existing process-wide proxy when URL, loopback
    // mode, and TLS options match; each caller still receives its own handle.
    const registration = registerActiveManagedProxyUrl(new URL(proxyUrl), {
      loopbackMode,
      proxyTls,
    });
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
    injectProxyEnv(proxyUrl, loopbackMode, proxyCaFile);
    proxylineHandle = installGlobalProxy({
      mode: "managed",
      proxyUrl,
      ...(proxyTls ? { proxyTls } : {}),
      ifActive: "replace",
      undici: MANAGED_PROXY_UNDICI_OPTIONS,
    });
    forceResetGlobalDispatcher({ preserveProxylineManaged: true });
    registration = registerActiveManagedProxyUrl(new URL(proxyUrl), {
      loopbackMode,
      proxyTls,
    });
  } catch (err) {
    if (registration) {
      stopActiveManagedProxyRegistration(registration);
    }
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

/** Stops a managed proxy handle if one was started. */
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

/** Registers a temporary direct route for trusted Gateway loopback control-plane URLs. */
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

/**
 * Carve out the operator-managed external proxy for the Browser plugin's
 * loopback CDP probe to a Chromium instance OpenClaw spawned itself.
 *
 * The managed proxy installs a process-wide undici dispatcher that would
 * otherwise route `http://127.0.0.1:<cdpPort>/json/version` and the
 * `ws://127.0.0.1:<cdpPort>/devtools/...` upgrade through the external
 * forward proxy, which returns 502 because nothing on the proxy listens for
 * the loopback CDP port. The bypass restores direct loopback delivery for
 * the duration the caller holds the returned `unregister` callback.
 *
 * Loopback-gated by structure: non-loopback authorities (e.g. an `attachOnly`
 * profile pointing at a remote CDP service like Browserless/Browserbase) are
 * not bypassed and continue to traverse the external proxy as configured.
 *
 * Honors `proxy.loopbackMode`:
 * - `gateway-only` (default): register the bypass.
 * - `proxy`: do not bypass — operator opted into proxy-everything routing.
 * - `block`: throw — operator forbids loopback IPC under managed proxy.
 *
 * Note: A loopback `attachOnly` profile whose `cdpUrl` is e.g.
 * `http://127.0.0.1:<port>` would also satisfy this gate. This mirrors the
 * structural semantics of `registerManagedProxyGatewayLoopbackBypass` —
 * loopback IPC on this host is assumed to be operator-trusted.
 */
export function registerManagedProxyBrowserCdpBypass(url: string): (() => void) | undefined {
  const authority = getGatewayControlPlaneBypassAuthority(url);
  if (!authority) {
    return undefined;
  }
  const loopbackMode = getActiveManagedProxyLoopbackMode();
  if (loopbackMode === "block") {
    throw new Error("proxy: Browser loopback CDP connections are blocked by proxy.loopbackMode");
  }
  if (loopbackMode === "proxy") {
    return undefined;
  }

  return proxylineHandle?.registerBypass({ url });
}
