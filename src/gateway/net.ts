import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { GatewayBindMode } from "../config/types.gateway.js";
import {
  __resetContainerEnvironmentCacheForTest,
  isContainerEnvironment,
} from "../infra/container-environment.js";
import {
  pickMatchingExternalInterfaceAddress,
  readNetworkInterfaces,
} from "../infra/network-interfaces.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import {
  isCanonicalDottedDecimalIPv4,
  isIpInCidr,
  isLoopbackIpAddress,
  isPrivateOrLoopbackIpAddress,
  normalizeIpAddress,
} from "../shared/net/ip.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

/**
 * Pick the primary non-internal IPv4 address (LAN IP).
 * Prefers common interface names (en0, eth0) then falls back to any external IPv4.
 */
export function pickPrimaryLanIPv4(): string | undefined {
  return pickMatchingExternalInterfaceAddress(readNetworkInterfaces(), {
    family: "IPv4",
    preferredNames: ["en0", "eth0"],
  });
}

export function normalizeHostHeader(hostHeader?: string): string {
  return normalizeLowercaseStringOrEmpty(hostHeader);
}

export function resolveHostName(hostHeader?: string): string {
  const host = normalizeHostHeader(hostHeader);
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      return host.slice(1, end);
    }
  }
  // Unbracketed IPv6 host (e.g. "::1") has no port and should be returned as-is.
  if (net.isIP(host) === 6) {
    return host;
  }
  const [name] = host.split(":");
  return name ?? "";
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  return isLoopbackIpAddress(ip);
}

/**
 * Returns true if the IP belongs to a private or loopback network range.
 * Private ranges: RFC1918, link-local, ULA IPv6, and CGNAT (100.64/10), plus loopback.
 */
export function isPrivateOrLoopbackAddress(ip: string | undefined): boolean {
  return isPrivateOrLoopbackIpAddress(ip);
}

function normalizeIp(ip: string | undefined): string | undefined {
  return normalizeIpAddress(ip);
}

function stripOptionalPort(ip: string): string {
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end !== -1) {
      return ip.slice(1, end);
    }
  }
  if (net.isIP(ip)) {
    return ip;
  }
  const lastColon = ip.lastIndexOf(":");
  if (lastColon > -1 && ip.includes(".") && ip.indexOf(":") === lastColon) {
    const candidate = ip.slice(0, lastColon);
    if (net.isIP(candidate) === 4) {
      return candidate;
    }
  }
  return ip;
}

function parseIpLiteral(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = stripOptionalPort(trimmed);
  const normalized = normalizeIp(stripped);
  if (!normalized || net.isIP(normalized) === 0) {
    return undefined;
  }
  return normalized;
}

function parseRealIp(realIp?: string): string | undefined {
  return parseIpLiteral(realIp);
}

function resolveForwardedClientIp(params: {
  forwardedFor?: string;
  trustedProxies?: string[];
}): string | undefined {
  const { forwardedFor, trustedProxies } = params;
  if (!trustedProxies?.length) {
    return undefined;
  }

  const forwardedChain: string[] = [];
  for (const entry of forwardedFor?.split(",") ?? []) {
    const normalized = parseIpLiteral(entry);
    if (normalized) {
      forwardedChain.push(normalized);
    }
  }
  if (forwardedChain.length === 0) {
    return undefined;
  }

  // Walk right-to-left and return the first untrusted hop.
  for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
    const hop = forwardedChain[index];
    if (isLoopbackAddress(hop)) {
      continue;
    }
    if (!isTrustedProxyAddress(hop, trustedProxies)) {
      return hop;
    }
  }
  return undefined;
}

export function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized || !trustedProxies || trustedProxies.length === 0) {
    return false;
  }

  return trustedProxies.some((proxy) => {
    const candidate = proxy.trim();
    if (!candidate) {
      return false;
    }
    return isIpInCidr(normalized, candidate);
  });
}

export function resolveClientIp(params: {
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: string[];
  /** Default false: only trust X-Real-IP when explicitly enabled. */
  allowRealIpFallback?: boolean;
}): string | undefined {
  const remote = normalizeIp(params.remoteAddr);
  if (!remote) {
    return undefined;
  }
  if (!isTrustedProxyAddress(remote, params.trustedProxies)) {
    return remote;
  }
  // Fail closed when traffic comes from a trusted proxy but client-origin headers
  // are missing or invalid. Falling back to the proxy's own IP can accidentally
  // treat unrelated requests as local/trusted.
  const forwardedIp = resolveForwardedClientIp({
    forwardedFor: params.forwardedFor,
    trustedProxies: params.trustedProxies,
  });
  if (forwardedIp) {
    return forwardedIp;
  }
  if (params.allowRealIpFallback) {
    return parseRealIp(params.realIp);
  }
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveRequestClientIp(
  req?: IncomingMessage,
  trustedProxies?: string[],
  allowRealIpFallback = false,
): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    realIp: headerValue(req.headers?.["x-real-ip"]),
    trustedProxies,
    allowRealIpFallback,
  });
}

export {
  isContainerEnvironment,
  __resetContainerEnvironmentCacheForTest as __resetContainerCacheForTest,
};

/**
 * Resolves gateway bind host with fallback strategy.
 *
 * Modes:
 * - loopback: 127.0.0.1 (rarely fails, but handled gracefully)
 * - lan: always 0.0.0.0 (no fallback)
 * - tailnet: Tailnet IPv4 if available, else loopback
 * - auto: 0.0.0.0 inside containers (Docker/Podman/K8s); loopback otherwise
 * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable
 *
 * @returns The bind address to use (never null)
 */
export async function resolveGatewayBindHost(
  bind: GatewayBindMode | undefined,
  customHost?: string,
): Promise<string> {
  const mode = bind ?? "loopback";

  if (mode === "loopback") {
    // 127.0.0.1 rarely fails, but handle gracefully
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0"; // extreme fallback
  }

  if (mode === "tailnet") {
    const tailnetIP = pickPrimaryTailnetIPv4();
    if (tailnetIP && (await canBindToHost(tailnetIP))) {
      return tailnetIP;
    }
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0";
  }

  if (mode === "lan") {
    return "0.0.0.0";
  }

  if (mode === "custom") {
    const host = customHost?.trim();
    if (!host) {
      return "0.0.0.0";
    } // invalid config → fall back to all

    if (isValidIPv4(host) && (await canBindToHost(host))) {
      return host;
    }
    // Custom IP failed → fall back to LAN
    return "0.0.0.0";
  }

  if (mode === "auto") {
    // Inside a container, loopback is unreachable from the host network
    // namespace, so prefer 0.0.0.0 to make port-forwarding work.
    if (isContainerEnvironment()) {
      return "0.0.0.0";
    }
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0";
  }

  return "0.0.0.0";
}

/**
 * Returns the effective default bind mode when `gateway.bind` is not explicitly
 * configured. Inside a detected container environment the default is `"auto"`
 * (which resolves to `0.0.0.0` for port-forwarding compatibility); on bare-metal
 * / VM hosts the default remains `"loopback"`.
 *
 * When {@link tailscaleMode} is `"serve"` or `"funnel"`, the function always
 * returns `"loopback"` because Tailscale serve/funnel architecturally requires
 * a loopback bind — container auto-detection must never override this.
 *
 * Use this only in gateway startup codepaths that execute in the same
 * environment as the eventual bind decision. Host-side diagnostics should keep
 * their own explicit defaults instead of inferring from the caller process.
 */
export function defaultGatewayBindMode(tailscaleMode?: string): GatewayBindMode {
  if (tailscaleMode && tailscaleMode !== "off") {
    return "loopback";
  }
  return isContainerEnvironment() ? "auto" : "loopback";
}

/**
 * Test if we can bind to a specific host address.
 * Creates a temporary server, attempts to bind, then closes it.
 *
 * @param host - The host address to test
 * @returns True if we can successfully bind to this address
 */
async function canBindToHost(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = net.createServer();
    testServer.once("error", () => {
      resolve(false);
    });
    testServer.once("listening", () => {
      testServer.close();
      resolve(true);
    });
    // Use port 0 to let OS pick an available port for testing
    testServer.listen(0, host);
  });
}

export async function resolveGatewayListenHosts(
  bindHost: string,
  opts?: { canBindToHost?: (host: string) => Promise<boolean> },
): Promise<string[]> {
  if (bindHost !== "127.0.0.1") {
    return [bindHost];
  }
  // Windows: uv_tcp_bind6 creates a dual-stack socket (no UV_TCP_IPV6ONLY), which
  // also accepts ::ffff:127.0.0.1 connections. Binding both ::1 and 127.0.0.1 on
  // the same port causes non-deterministic TCP routing → HTTP requests hang silently.
  if (process.platform === "win32") {
    return [bindHost];
  }
  const canBind = opts?.canBindToHost ?? canBindToHost;
  if (await canBind("::1")) {
    return [bindHost, "::1"];
  }
  return [bindHost];
}

/**
 * Validate if a string is a valid IPv4 address.
 *
 * @param host - The string to validate
 * @returns True if valid IPv4 format
 */
export function isValidIPv4(host: string): boolean {
  return isCanonicalDottedDecimalIPv4(host);
}

/**
 * Check if a hostname or IP refers to the local machine.
 * Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
 * Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
 */
export function isLoopbackHost(host: string): boolean {
  const parsed = parseHostForAddressChecks(host);
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  return isLoopbackAddress(parsed.unbracketedHost);
}

/**
 * Local-facing host check for inbound requests:
 * - loopback hosts (localhost/127.x/::1 and mapped forms)
 * - Tailscale Serve/Funnel hostnames (*.ts.net)
 */
export function isLocalishHost(hostHeader?: string): boolean {
  const host = resolveHostName(hostHeader);
  if (!host) {
    return false;
  }
  return isLoopbackHost(host) || host.endsWith(".ts.net");
}

/**
 * Check if a hostname or IP refers to a private or loopback address.
 * Handles the same hostname formats as isLoopbackHost, but also accepts
 * RFC 1918, link-local, CGNAT, and IPv6 ULA/link-local addresses.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const parsed = parseHostForAddressChecks(host);
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  const normalized = normalizeIp(parsed.unbracketedHost);
  if (!normalized || !isPrivateOrLoopbackAddress(normalized)) {
    return false;
  }
  // isPrivateOrLoopbackAddress reuses SSRF-blocking ranges for IPv6, which
  // include unspecified (::) and multicast (ff00::/8). Exclude these —
  // they are not private/loopback unicast endpoints. (Multicast is UDP-only
  // so TCP/WebSocket connections would fail regardless.)
  if (net.isIP(normalized) === 6) {
    if (normalized.startsWith("ff")) {
      return false;
    }
    if (normalized === "::") {
      return false;
    }
  }
  return true;
}

function parseHostForAddressChecks(
  host: string,
): { isLocalhost: boolean; unbracketedHost: string } | null {
  if (!host) {
    return null;
  }
  const normalizedHost = normalizeLowercaseStringOrEmpty(host);
  const canonicalHost = normalizedHost.replace(/\.+$/, "");
  if (canonicalHost === "localhost") {
    return { isLocalhost: true, unbracketedHost: canonicalHost };
  }
  return {
    isLocalhost: false,
    // Handle bracketed IPv6 addresses like [::1]
    unbracketedHost:
      normalizedHost.startsWith("[") && normalizedHost.endsWith("]")
        ? normalizedHost.slice(1, -1)
        : normalizedHost,
  };
}

/**
 * Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
 *
 * Returns true if the URL is secure for transmitting data:
 * - wss:// (TLS) is always secure
 * - ws:// is secure only for loopback addresses by default
 * - optional break-glass: private ws:// can be enabled for trusted networks
 *
 * All other ws:// URLs are considered insecure because both credentials
 * AND chat/conversation data would be exposed to network interception.
 */
export function isSecureWebSocketUrl(
  url: string,
  opts?: {
    allowPrivateWs?: boolean;
  },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Node's ws client accepts http(s) URLs and normalizes them to ws(s).
  // Treat those aliases the same way here so loopback cron announce delivery
  // and TLS-backed https endpoints follow the same security policy.
  const protocol =
    parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;

  if (protocol === "wss:") {
    return true;
  }

  if (protocol !== "ws:") {
    return false;
  }

  // Default policy stays strict: loopback-only plaintext ws://.
  if (isLoopbackHost(parsed.hostname)) {
    return true;
  }
  // Optional break-glass for trusted private-network overlays.
  if (opts?.allowPrivateWs) {
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      return true;
    }
    // Hostnames may resolve to private networks (for example in VPN/Tailnet DNS),
    // but resolution is not available in this synchronous validator.
    const hostForIpCheck =
      parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    return net.isIP(hostForIpCheck) === 0;
  }
  return false;
}
