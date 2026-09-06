import type { IncomingMessage } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import {
  hasForwardedRequestHeaders,
  isLoopbackAddress,
  isTrustedProxyAddress,
  resolveClientIp,
  resolveRequestClientIpFromHeaders,
} from "./net.js";

export const PROXY_ATTRIBUTION_REQUIRED_REASON = "proxy_attribution_required";
export const PROXY_ATTRIBUTION_GUIDANCE =
  "Configure gateway.trustedProxies narrowly and make the proxy overwrite or safely rebuild forwarded client headers.";

export type GatewayTailscaleIngressMode = "serve" | "funnel";

export type GatewayTailscaleIngressEndpoint = {
  host: "127.0.0.1";
  port: number;
};

export type GatewayIngressTransport =
  | { kind: "ordinary" }
  | { kind: "managed-tailscale"; mode: GatewayTailscaleIngressMode };

export type VerifiedTailscaleIngressIdentity = {
  login: string;
  name: string;
  profilePic?: string;
};

type GatewayIngressRateLimitSubject = {
  key: string;
};

type AttributedGatewayIngress = {
  clientIp: string;
  rateLimit: {
    subject: GatewayIngressRateLimitSubject;
    resetOnSuccess: true;
  };
};

export type GatewayIngressAttribution =
  | (AttributedGatewayIngress & { kind: "direct-local" })
  | (AttributedGatewayIngress & { kind: "direct-remote" })
  | (AttributedGatewayIngress & {
      kind: "trusted-proxy";
      /** Deny-only observation; this never grants managed Tailscale provenance. */
      externalTailscaleExposure?: "funnel";
    })
  | (AttributedGatewayIngress & {
      kind: "tailscale-serve";
      verifyIdentity: () => Promise<VerifiedTailscaleIngressIdentity | undefined>;
    })
  | (AttributedGatewayIngress & { kind: "tailscale-funnel" })
  | {
      kind: "unattributable-proxy";
      reason: typeof PROXY_ATTRIBUTION_REQUIRED_REASON;
      guidance: typeof PROXY_ATTRIBUTION_GUIDANCE;
      remoteAddress: string;
    };

export type GatewayAttributedIngress = Exclude<
  GatewayIngressAttribution,
  { kind: "unattributable-proxy" }
>;

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

const requestTransport = new WeakMap<IncomingMessage, GatewayIngressTransport>();
const preparedAttribution = new WeakMap<IncomingMessage, GatewayIngressAttribution>();

/** Records listener-owned provenance before any request-time policy runs. */
export function markGatewayIngressTransport(
  req: IncomingMessage,
  transport: GatewayIngressTransport,
): void {
  const existing = requestTransport.get(req);
  if (existing) {
    if (
      existing.kind !== transport.kind ||
      (existing.kind === "managed-tailscale" &&
        transport.kind === "managed-tailscale" &&
        existing.mode !== transport.mode)
    ) {
      throw new Error("Gateway ingress transport was already assigned");
    }
    return;
  }
  requestTransport.set(req, transport);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function unattributableProxy(remoteAddress: string): GatewayIngressAttribution {
  return {
    kind: "unattributable-proxy",
    reason: PROXY_ATTRIBUTION_REQUIRED_REASON,
    guidance: PROXY_ATTRIBUTION_GUIDANCE,
    remoteAddress,
  };
}

function attributed<
  Kind extends Exclude<GatewayIngressAttribution["kind"], "unattributable-proxy">,
>(kind: Kind, clientIp: string): AttributedGatewayIngress & { kind: Kind } {
  return {
    kind,
    clientIp,
    rateLimit: {
      subject: {
        key: clientIp,
      },
      resetOnSuccess: true,
    },
  };
}

function hasTailscaleProxyHeaders(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  return Boolean(
    headers["x-forwarded-for"] && headers["x-forwarded-proto"] && headers["x-forwarded-host"],
  );
}

function hasTailscaleOwnedHeaders(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  return [
    "tailscale-funnel-request",
    "tailscale-headers-info",
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-user-profile-pic",
  ].some((name) => headers[name] !== undefined);
}

function resolveTailscaleClientIp(req: IncomingMessage): string | undefined {
  return resolveClientIp({
    remoteAddr: req.socket?.remoteAddress,
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    trustedProxies: ["127.0.0.1", "::1"],
  });
}

function resolveManagedTailscaleIngress(params: {
  req: IncomingMessage;
  mode: GatewayTailscaleIngressMode;
  remoteAddress: string;
  tailscaleWhois: TailscaleWhoisLookup;
}): GatewayIngressAttribution {
  const { req, mode, remoteAddress, tailscaleWhois } = params;
  if (!isLoopbackAddress(remoteAddress) || !hasTailscaleProxyHeaders(req)) {
    return unattributableProxy(remoteAddress);
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp || isLoopbackAddress(clientIp)) {
    return unattributableProxy(remoteAddress);
  }
  const funnelMarker = headerValue(req.headers?.["tailscale-funnel-request"]);
  if (mode === "funnel") {
    return !funnelMarker || funnelMarker === "?1"
      ? attributed("tailscale-funnel", clientIp)
      : unattributableProxy(remoteAddress);
  }
  if (funnelMarker) {
    return unattributableProxy(remoteAddress);
  }

  const headerLogin = normalizeOptionalString(req.headers?.["tailscale-user-login"]);
  const headerName = normalizeOptionalString(req.headers?.["tailscale-user-name"]);
  const profilePic = normalizeOptionalString(req.headers?.["tailscale-user-profile-pic"]);
  let identityPromise: Promise<VerifiedTailscaleIngressIdentity | undefined> | undefined;
  const verifyIdentity = () => {
    if (!headerLogin) {
      return Promise.resolve(undefined);
    }
    identityPromise ??= (async () => {
      try {
        const whois = await tailscaleWhois(clientIp);
        if (!whois?.login || whois.login.toLowerCase() !== headerLogin.toLowerCase()) {
          return undefined;
        }
        return {
          login: whois.login,
          name: whois.name ?? headerName ?? whois.login,
          ...(profilePic ? { profilePic } : {}),
        };
      } catch {
        return undefined;
      }
    })();
    return identityPromise;
  };
  return { ...attributed("tailscale-serve", clientIp), verifyIdentity };
}

function resolveGatewayIngressAttribution(params: {
  req: IncomingMessage;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  tailscaleWhois?: TailscaleWhoisLookup;
}): GatewayIngressAttribution {
  const { req } = params;
  const remoteAddress =
    resolveClientIp({ remoteAddr: req.socket?.remoteAddress }) ??
    req.socket?.remoteAddress ??
    "unknown";
  const transport = requestTransport.get(req) ?? { kind: "ordinary" as const };

  if (transport.kind === "managed-tailscale") {
    return resolveManagedTailscaleIngress({
      req,
      mode: transport.mode,
      remoteAddress,
      tailscaleWhois: params.tailscaleWhois ?? readTailscaleWhoisIdentity,
    });
  }

  const hasProxyHeaders = hasForwardedRequestHeaders(req);
  const hasTailscaleHeaders = hasTailscaleOwnedHeaders(req);
  if (isLoopbackAddress(remoteAddress) && !hasProxyHeaders && !hasTailscaleHeaders) {
    return attributed("direct-local", remoteAddress);
  }
  if (isTrustedProxyAddress(remoteAddress, params.trustedProxies)) {
    const clientIp = resolveRequestClientIpFromHeaders(
      req,
      params.trustedProxies,
      params.allowRealIpFallback === true,
    );
    if (!clientIp || isLoopbackAddress(clientIp)) {
      return unattributableProxy(remoteAddress);
    }
    return {
      ...attributed("trusted-proxy", clientIp),
      ...(headerValue(req.headers?.["tailscale-funnel-request"]) === "?1"
        ? { externalTailscaleExposure: "funnel" as const }
        : {}),
    };
  }
  // Tailscale-owned headers grant managed semantics only on the dedicated listener.
  // An explicitly trusted ordinary proxy remains generic; every other source fails closed.
  if (hasProxyHeaders || hasTailscaleHeaders) {
    return unattributableProxy(remoteAddress);
  }
  return attributed("direct-remote", remoteAddress);
}

export function prepareGatewayIngressAttribution(
  params: Parameters<typeof resolveGatewayIngressAttribution>[0],
): GatewayIngressAttribution {
  const existing = preparedAttribution.get(params.req);
  if (existing) {
    return existing;
  }
  const prepared = resolveGatewayIngressAttribution(params);
  preparedAttribution.set(params.req, prepared);
  return prepared;
}

export function readPreparedGatewayIngressAttribution(
  req: IncomingMessage,
): GatewayIngressAttribution | undefined {
  return preparedAttribution.get(req);
}

export type GatewayUnattributableProxyReporter = (
  attribution: Extract<GatewayIngressAttribution, { kind: "unattributable-proxy" }>,
) => void;

/** Emits one actionable warning per runtime without attacker-controlled log growth. */
export function createGatewayUnattributableProxyReporter(log: {
  warn: (message: string) => void;
}): GatewayUnattributableProxyReporter {
  let emitted = false;
  return (attribution) => {
    if (emitted) {
      return;
    }
    emitted = true;
    log.warn(
      `gateway: observed unattributable proxy-shaped traffic from ${attribution.remoteAddress}; Gateway-authenticated routes reject it, while plugin-authenticated routes ignore forwarded claims. ${attribution.guidance}`,
    );
  };
}
