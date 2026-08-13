import { isLoopbackIpAddress, type ParsedIpAddress } from "@openclaw/net-policy/ip";
import { isWssUrl } from "@openclaw/net-policy/url-protocol";
import type { ClientOptions, CertMeta, WebSocket } from "ws";
import {
  normalizeFingerprint,
  parseGatewayIpAddress,
  parseHostForAddressChecks,
} from "./client-address-utils.js";

const PRIVATE_OR_LOOPBACK_IPV4_RANGES = new Set<string>([
  "loopback",
  "private",
  "linkLocal",
  "carrierGradeNat",
]);
const PRIVATE_OR_LOOPBACK_IPV6_RANGES = new Set<string>([
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "deprecatedSiteLocal",
]);

function isPrivateOrLoopbackIpAddress(address: ParsedIpAddress): boolean {
  const ranges =
    address.kind() === "ipv4" ? PRIVATE_OR_LOOPBACK_IPV4_RANGES : PRIVATE_OR_LOOPBACK_IPV6_RANGES;
  return ranges.has(address.range());
}

export function isGatewayLoopbackHost(host: string): boolean {
  const parsed = parseHostForAddressChecks(host);
  return Boolean(parsed && (parsed.isLocalhost || isLoopbackIpAddress(parsed.unbracketedHost)));
}

function isPrivateOrLoopbackHost(host: string): boolean {
  const parsed = parseHostForAddressChecks(host);
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  const address = parseGatewayIpAddress(parsed.unbracketedHost);
  return Boolean(address && isPrivateOrLoopbackIpAddress(address));
}

function isTrustedPlaintextWebSocketHost(hostname: string): boolean {
  if (isPrivateOrLoopbackHost(hostname)) {
    return true;
  }
  const normalized = hostname.toLowerCase().trim().replace(/\.+$/, "");
  return normalized.endsWith(".local") || normalized.endsWith(".ts.net");
}

function isSecureWebSocketUrl(rawUrl: string, options?: { allowPrivateWs?: boolean }): boolean {
  try {
    const url = new URL(rawUrl);
    const protocol =
      url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
    if (protocol === "wss:") {
      return true;
    }
    if (protocol !== "ws:") {
      return false;
    }
    if (isGatewayLoopbackHost(url.hostname) || isTrustedPlaintextWebSocketHost(url.hostname)) {
      return true;
    }
    if (options?.allowPrivateWs === true) {
      const hostForIpCheck =
        url.hostname.startsWith("[") && url.hostname.endsWith("]")
          ? url.hostname.slice(1, -1)
          : url.hostname;
      return (
        isPrivateOrLoopbackHost(url.hostname) || parseGatewayIpAddress(hostForIpCheck) === undefined
      );
    }
    return false;
  } catch {
    return false;
  }
}

export class GatewayWebSocketTransportConfigurationError extends Error {}

type FingerprintCheckingClientOptions = Omit<ClientOptions, "checkServerIdentity"> & {
  checkServerIdentity?: (servername: string, cert: CertMeta) => Error | undefined;
};

type GatewayWebSocketTransport = {
  options: ClientOptions;
  validateSocket(socket: WebSocket): Error | null;
};

export function resolveGatewayWebSocketTransport(params: {
  url: string;
  tlsFingerprint?: string;
  env?: NodeJS.ProcessEnv;
  options: Omit<ClientOptions, "checkServerIdentity" | "rejectUnauthorized">;
  normalizeTlsFingerprint?: (fingerprint: string | undefined) => string;
}): GatewayWebSocketTransport {
  const usesTls = isWssUrl(params.url);
  if (params.tlsFingerprint && !usesTls) {
    throw new GatewayWebSocketTransportConfigurationError(
      "gateway tls fingerprint requires wss:// gateway url",
    );
  }
  const allowPrivateWs = (params.env ?? process.env).OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
  if (!isSecureWebSocketUrl(params.url, { allowPrivateWs })) {
    let displayHost = params.url;
    try {
      displayHost = new URL(params.url).hostname || params.url;
    } catch {
      // Use the raw URL when syntax is malformed.
    }
    throw new GatewayWebSocketTransportConfigurationError(
      `SECURITY ERROR: Cannot connect to "${displayHost}" over plaintext ws://. ` +
        "Both credentials and chat data would be exposed to network interception. " +
        "Use wss:// for remote URLs. Safe defaults: keep gateway.bind=loopback and connect via SSH tunnel " +
        "(ssh -N -L 18789:127.0.0.1:18789 user@gateway-host), or use Tailscale Serve/Funnel. " +
        (allowPrivateWs
          ? ""
          : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1. ") +
        "Run `openclaw doctor --fix` for guidance.",
    );
  }

  const normalize = params.normalizeTlsFingerprint ?? normalizeFingerprint;
  const options: FingerprintCheckingClientOptions = { ...params.options };
  if (usesTls && params.tlsFingerprint) {
    options.rejectUnauthorized = false;
    options.checkServerIdentity = (_hostValue: string, cert: CertMeta) => {
      const fingerprintValue =
        typeof cert === "object" && cert && "fingerprint256" in cert
          ? ((cert as { fingerprint256?: string }).fingerprint256 ?? "")
          : "";
      const fingerprint = normalize(typeof fingerprintValue === "string" ? fingerprintValue : "");
      const expected = normalize(params.tlsFingerprint);
      if (!expected) {
        return undefined;
      }
      if (!fingerprint) {
        return new Error("Missing server TLS fingerprint");
      }
      if (fingerprint !== expected) {
        return new Error("Server TLS fingerprint mismatch");
      }
      return undefined;
    };
  }

  return {
    options: options as ClientOptions,
    validateSocket: (socket) => {
      if (!params.tlsFingerprint) {
        return null;
      }
      const expected = normalize(params.tlsFingerprint);
      if (!expected) {
        return new Error("gateway tls fingerprint missing");
      }
      const rawSocket = (
        socket as WebSocket & {
          _socket?: { getPeerCertificate?: () => { fingerprint256?: string } };
        }
      )["_socket"];
      if (!rawSocket || typeof rawSocket.getPeerCertificate !== "function") {
        return new Error("gateway tls fingerprint unavailable");
      }
      const cert = rawSocket.getPeerCertificate();
      const fingerprint = normalize(cert?.fingerprint256 ?? "");
      if (!fingerprint) {
        return new Error("gateway tls fingerprint unavailable");
      }
      return fingerprint === expected ? null : new Error("gateway tls fingerprint mismatch");
    },
  };
}
