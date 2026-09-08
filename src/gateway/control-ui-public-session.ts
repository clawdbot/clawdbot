import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import {
  buildControlUiPublicSessionSharePath,
  parseControlUiPublicSessionShareUrl,
} from "@openclaw/session-url-contract/public-share";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import { isLoopbackHost, resolveHostName } from "./net.js";

const PUBLIC_SESSION_RATE_WINDOW_MS = 60_000;
const PUBLIC_SESSION_CLIENT_REQUEST_LIMIT = 20;
const PUBLIC_SESSION_PUBLICATION_REQUEST_LIMIT = 120;
const PUBLIC_SESSION_MAX_CLIENTS = 4_096;
const PUBLIC_SESSION_MAX_PUBLICATIONS = 2_048;
const PUBLIC_SESSION_MAX_CONCURRENT_READS = 8;
const PUBLIC_SESSION_MAX_CONCURRENT_READS_PER_PUBLICATION = 2;

type RateWindow = {
  timestamps: number[];
};

type PublicSessionAdmissionResult =
  | { kind: "ok"; value: string | null }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "unavailable" };

type ControlUiPublicSessionRequestGate = {
  admitClient(
    clientKey: string,
  ): { kind: "ok" } | { kind: "rate-limited"; retryAfterSeconds: number };
  run(params: {
    publicationKey: string;
    requestKey: string;
    config: OpenClawConfig;
    work: () => Promise<string | null>;
  }): Promise<PublicSessionAdmissionResult>;
};

function admitRateWindow(
  windows: Map<string, RateWindow>,
  key: string,
  limit: number,
  maxEntries: number,
  now: number,
): number | undefined {
  const cutoff = now - PUBLIC_SESSION_RATE_WINDOW_MS;
  let window = windows.get(key);
  if (!window) {
    if (windows.size >= maxEntries) {
      for (const [candidateKey, candidate] of windows) {
        candidate.timestamps = candidate.timestamps.filter((timestamp) => timestamp > cutoff);
        if (candidate.timestamps.length === 0) {
          windows.delete(candidateKey);
        }
      }
    }
    if (windows.size >= maxEntries) {
      // Anonymous identities are attacker-controlled. Evict the oldest bucket
      // instead of letting map saturation deny every previously unseen viewer.
      pruneMapToMaxSize(windows, maxEntries - 1);
    }
    window = { timestamps: [] };
    windows.set(key, window);
  }
  window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff);
  const oldest = window.timestamps[0];
  if (window.timestamps.length >= limit && oldest !== undefined) {
    return Math.max(1, oldest + PUBLIC_SESSION_RATE_WINDOW_MS - now);
  }
  window.timestamps.push(now);
  return undefined;
}

/** Creates the fixed, process-local abuse boundary for anonymous transcript reads. */
function createControlUiPublicSessionRequestGate(): ControlUiPublicSessionRequestGate {
  const clientWindows = new Map<string, RateWindow>();
  const publicationWindows = new Map<string, RateWindow>();
  const activeByPublication = new Map<string, number>();
  const inFlight = new Map<string, Promise<string | null>>();
  const configIds = new WeakMap<object, number>();
  let nextConfigId = 1;
  let activeReads = 0;

  const configId = (config: OpenClawConfig): number => {
    const existing = configIds.get(config);
    if (existing !== undefined) {
      return existing;
    }
    const created = nextConfigId++;
    configIds.set(config, created);
    return created;
  };

  return {
    admitClient(clientKey) {
      const retryMs = admitRateWindow(
        clientWindows,
        clientKey,
        PUBLIC_SESSION_CLIENT_REQUEST_LIMIT,
        PUBLIC_SESSION_MAX_CLIENTS,
        Date.now(),
      );
      return retryMs === undefined
        ? { kind: "ok" }
        : { kind: "rate-limited", retryAfterSeconds: Math.ceil(retryMs / 1_000) };
    },
    async run(params: {
      publicationKey: string;
      requestKey: string;
      config: OpenClawConfig;
      work: () => Promise<string | null>;
    }): Promise<PublicSessionAdmissionResult> {
      const now = Date.now();
      const publicationRetryMs = admitRateWindow(
        publicationWindows,
        params.publicationKey,
        PUBLIC_SESSION_PUBLICATION_REQUEST_LIMIT,
        PUBLIC_SESSION_MAX_PUBLICATIONS,
        now,
      );
      if (publicationRetryMs !== undefined) {
        return {
          kind: "rate-limited",
          retryAfterSeconds: Math.ceil(publicationRetryMs / 1_000),
        };
      }

      const inFlightKey = `${configId(params.config)}:${params.requestKey}`;
      const existing = inFlight.get(inFlightKey);
      if (existing) {
        return { kind: "ok", value: await existing };
      }
      const publicationActive = activeByPublication.get(params.publicationKey) ?? 0;
      if (
        activeReads >= PUBLIC_SESSION_MAX_CONCURRENT_READS ||
        publicationActive >= PUBLIC_SESSION_MAX_CONCURRENT_READS_PER_PUBLICATION
      ) {
        return { kind: "unavailable" };
      }

      activeReads += 1;
      activeByPublication.set(params.publicationKey, publicationActive + 1);
      const pending = Promise.resolve().then(params.work);
      inFlight.set(inFlightKey, pending);
      try {
        return { kind: "ok", value: await pending };
      } finally {
        inFlight.delete(inFlightKey);
        activeReads -= 1;
        const remaining = (activeByPublication.get(params.publicationKey) ?? 1) - 1;
        if (remaining > 0) {
          activeByPublication.set(params.publicationKey, remaining);
        } else {
          activeByPublication.delete(params.publicationKey);
        }
      }
    },
  };
}

function isControlUiPublicSessionPath(pathname: string, basePath: string): boolean {
  return pathname === `${basePath}/share/session`;
}

function hasSingleHttpsForwardedProto(req: IncomingMessage): boolean {
  const value = req.headers["x-forwarded-proto"];
  return typeof value === "string" && value.trim().toLowerCase() === "https";
}

async function serveControlUiPublicSession(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  basePath: string,
  cfg: OpenClawConfig | undefined,
  requestGate: ControlUiPublicSessionRequestGate,
  clientKey: string,
  secureIngress: boolean,
  publicOrigin?: string,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  const unavailable = (status: 404 | 429 | 503, retryAfterSeconds = 1) => {
    const body =
      status === 404
        ? "This public session is unavailable."
        : status === 429
          ? "Too many public session requests. Please retry later."
          : "This public session is temporarily unavailable. Please retry.";
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    if (status === 429 || status === 503) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const publicShare = parseControlUiPublicSessionShareUrl(url, basePath);
  const origin = resolveControlUiShareOrigin(req, publicOrigin);
  const offsetText = url.searchParams.get("offset") ?? "0";
  const offset = Number(offsetText);
  if (
    (req.method !== "GET" && req.method !== "HEAD") ||
    !publicShare ||
    !origin ||
    !cfg ||
    url.searchParams.getAll("offset").length > 1 ||
    !/^(?:0|[1-9][0-9]{0,9})$/u.test(offsetText)
  ) {
    unavailable(404);
    return;
  }
  if (!secureIngress) {
    unavailable(404);
    return;
  }
  // A truthful HEAD would still need authorization, transcript I/O, redaction, and
  // rendering to compute the GET status and length. Refuse it instead of doing that work.
  if (req.method === "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }
  const clientAdmission = requestGate.admitClient(clientKey);
  if (clientAdmission.kind === "rate-limited") {
    unavailable(429, clientAdmission.retryAfterSeconds);
    return;
  }
  try {
    const { resolvePublicSessionShareToken } = await import("./control-ui-public-session-token.js");
    const locator = resolvePublicSessionShareToken(publicShare.token);
    if (!locator) {
      unavailable(404);
      return;
    }
    const { isPublicSessionShareActive, readPublicSessionShare } =
      await import("./control-ui-public-session-read.js");
    const { renderPublicSessionDocument } = await import("./control-ui-public-session-render.js");
    const admitted = await requestGate.run({
      publicationKey: locator.shareId,
      requestKey: JSON.stringify([
        createHash("sha256").update(publicShare.token).digest("base64url"),
        offset,
        origin,
      ]),
      config: cfg,
      work: async () => {
        const session = await readPublicSessionShare(cfg, locator, { offset });
        if (!session) {
          return null;
        }
        const latestUrl = buildControlUiPublicSessionSharePath({
          basePath,
          token: publicShare.token,
        });
        const canonicalUrl =
          publicOrigin || req.socket instanceof TLSSocket ? `${origin}${latestUrl}` : undefined;
        return renderPublicSessionDocument({
          ...session,
          latestUrl,
          ...(canonicalUrl ? { canonicalUrl } : {}),
          isLatest: offset === 0,
          ...(session.olderOffset !== undefined
            ? { olderUrl: `${latestUrl}&offset=${session.olderOffset}` }
            : {}),
          cardUrl: `${origin}${basePath}/share/card.png`,
        });
      },
    });
    if (admitted.kind === "rate-limited") {
      unavailable(429, admitted.retryAfterSeconds);
      return;
    }
    if (admitted.kind === "unavailable") {
      unavailable(503);
      return;
    }
    const body = admitted.value;
    if (!body || !isPublicSessionShareActive(cfg, locator)) {
      unavailable(404);
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
  } catch {
    unavailable(503);
  }
}

export function createControlUiPublicSessionRoute() {
  const requestGate = createControlUiPublicSessionRequestGate();
  return {
    matches: isControlUiPublicSessionPath,
    reject(res: ServerResponse): true {
      respondNotFound(res);
      return true;
    },
    async serve(params: {
      req: IncomingMessage;
      res: ServerResponse;
      basePath: string;
      config: OpenClawConfig;
      ingress: GatewayAttributedIngress;
    }): Promise<true> {
      const url = params.req.url ? new URL(params.req.url, "http://localhost") : undefined;
      if (!url) {
        respondNotFound(params.res);
        return true;
      }
      const publicOrigin = resolveGatewayPublicOrigin(params.config);
      const advertisedHttps = publicOrigin?.startsWith("https://") === true;
      const trustedProxyHttps =
        params.ingress.kind === "trusted-proxy" &&
        advertisedHttps &&
        hasSingleHttpsForwardedProto(params.req);
      const managedHttps =
        (params.ingress.kind === "tailscale-serve" || params.ingress.kind === "tailscale-funnel") &&
        advertisedHttps;
      const secureIngress =
        params.req.socket instanceof TLSSocket ||
        (params.ingress.kind === "direct-local" &&
          isLoopbackHost(resolveHostName(params.req.headers.host))) ||
        trustedProxyHttps ||
        managedHttps;
      await serveControlUiPublicSession(
        params.req,
        params.res,
        url,
        params.basePath,
        params.config,
        requestGate,
        params.ingress.rateLimit.subject.key,
        secureIngress,
        publicOrigin,
      );
      return true;
    },
  };
}
