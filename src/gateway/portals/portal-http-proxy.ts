import { timingSafeEqual } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { request as requestHttp } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { createLoopbackConnectOptions } from "../../infra/loopback-connect.js";

const PORTAL_AUTH_NAME = "openclaw_portal";
// Browser cookie jars are hostname-scoped, so the stable listener port in the
// auth cookie name keeps concurrently open portals from replacing each other.
function portalAuthCookieName(listenPort: number): string {
  return `${PORTAL_AUTH_NAME}_${listenPort}`;
}

// Cookies are hostname-scoped, not port-scoped. Per-instance prefixes keep cookies
// from sibling or closed portals out of the current agent-run application.
const PORTAL_COOKIE_PREFIX = "oc_portal_";
// The portal URL carries the bearer token in its query, so the browser must never
// attach it as a Referer. The target controls its own response headers, so this is
// forced after upstream headers are copied rather than merely defaulted.
const PORTAL_REFERRER_POLICY = "no-referrer";
const MAX_WEBSOCKET_RESPONSE_HEADER_BYTES = 64 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type PortalTarget =
  | { kind: "local"; port: number }
  | {
      kind: "worker";
      environmentId: string;
      ownerEpoch: number;
      remotePort: number;
      connect: () => Promise<Duplex>;
    };

type PortalProxyTarget = {
  listenPort: number;
  target: PortalTarget;
  token: string;
  cookieNamespace: string;
};

type PortalAuthorization =
  | { kind: "authorized"; requestPath: string; setCookie: boolean }
  | { kind: "unauthorized" };

function tokensEqual(candidate: string | undefined, expected: string): boolean {
  if (!candidate) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function readPortalCookie(
  cookieHeader: string | undefined,
  listenPort: number,
): string | undefined {
  const authCookieName = portalAuthCookieName(listenPort);
  for (const segment of cookieHeader?.split(";") ?? []) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== authCookieName) {
      continue;
    }
    return segment.slice(separator + 1).trim();
  }
  return undefined;
}

function portalCookiePrefix(cookieNamespace: string): string {
  return `${PORTAL_COOKIE_PREFIX}${cookieNamespace}_`;
}

function readTargetCookies(
  cookieHeader: string | undefined,
  cookieNamespace: string,
): string | undefined {
  const prefix = portalCookiePrefix(cookieNamespace);
  const retained = (cookieHeader?.split(";") ?? []).flatMap((segment) => {
    const separator = segment.indexOf("=");
    if (separator <= 0) {
      return [];
    }
    const name = segment.slice(0, separator).trim();
    if (!name.startsWith(prefix) || name.length === prefix.length) {
      return [];
    }
    return [`${name.slice(prefix.length)}=${segment.slice(separator + 1).trim()}`];
  });
  const normalized = retained.join("; ");
  return normalized || undefined;
}

function rewriteTargetCookie(cookie: string, cookieNamespace: string): string | undefined {
  const [cookiePair, ...attributes] = cookie.split(";");
  const separator = cookiePair?.indexOf("=") ?? -1;
  if (!cookiePair || separator <= 0) {
    return undefined;
  }
  const name = cookiePair.slice(0, separator).trim();
  if (!name) {
    return undefined;
  }
  const retainedAttributes = attributes.filter((attribute) => !/^\s*domain\s*=/iu.test(attribute));
  const suffix = retainedAttributes.length > 0 ? `;${retainedAttributes.join(";")}` : "";
  return `${portalCookiePrefix(cookieNamespace)}${name}=${cookiePair.slice(separator + 1)}${suffix}`;
}

function parsePortalUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? "/", "http://openclaw.invalid");
  } catch {
    return undefined;
  }
}

function authorizePortalRequest(
  req: IncomingMessage,
  target: PortalProxyTarget,
): PortalAuthorization {
  const url = parsePortalUrl(req);
  const queryToken = url?.searchParams.get(PORTAL_AUTH_NAME) ?? undefined;
  if (tokensEqual(queryToken, target.token)) {
    url?.searchParams.delete(PORTAL_AUTH_NAME);
    return {
      kind: "authorized",
      requestPath: `${url?.pathname ?? "/"}${url?.search ?? ""}`,
      setCookie: true,
    };
  }
  if (tokensEqual(readPortalCookie(req.headers.cookie, target.listenPort), target.token)) {
    url?.searchParams.delete(PORTAL_AUTH_NAME);
    return {
      kind: "authorized",
      requestPath: `${url?.pathname ?? "/"}${url?.search ?? ""}`,
      setCookie: false,
    };
  }
  return { kind: "unauthorized" };
}

function portalCookie(target: PortalProxyTarget, tls: boolean): string {
  return `${portalAuthCookieName(target.listenPort)}=${target.token}; HttpOnly; SameSite=Lax; Path=/${tls ? "; Secure" : ""}`;
}

function setProxyResponseHeader(
  res: ServerResponse,
  name: string,
  value: string | string[] | number,
  cookieNamespace: string,
): void {
  if (name !== "set-cookie") {
    res.setHeader(name, value);
    return;
  }
  const existing = res.getHeader("Set-Cookie");
  const existingCookies =
    existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  const targetCookies = Array.isArray(value) ? value : [String(value)];
  const rewrittenCookies = targetCookies.flatMap((cookie) => {
    const rewritten = rewriteTargetCookie(cookie, cookieNamespace);
    return rewritten ? [rewritten] : [];
  });
  const cookies = [...existingCookies.map(String), ...rewrittenCookies];
  if (cookies.length > 0) {
    res.setHeader("Set-Cookie", cookies);
  }
}

function htmlResponse(
  res: ServerResponse,
  statusCode: number,
  html: string,
  headOnly: boolean,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", PORTAL_REFERRER_POLICY);
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(headOnly ? undefined : html);
}

function respondPortalUnauthorized(req: IncomingMessage, res: ServerResponse): void {
  const html =
    "<!doctype html><meta charset=utf-8><title>Private portal</title>" +
    "<p>This portal is private. Open it from the OpenClaw Control UI.</p>";
  htmlResponse(res, 401, html, req.method === "HEAD");
}

function portalWaitingHtml(targetPort: number): string {
  return (
    '<!doctype html><meta charset=utf-8><meta http-equiv="refresh" content="2">' +
    `<title>Waiting for app</title><p>Waiting for the app on port ${targetPort}…</p>`
  );
}

function respondPortalWaiting(req: IncomingMessage, res: ServerResponse, targetPort: number): void {
  htmlResponse(res, 502, portalWaitingHtml(targetPort), req.method === "HEAD");
}

async function connectPortalTarget(target: PortalTarget): Promise<Duplex> {
  if (target.kind === "worker") {
    return await target.connect();
  }
  return net.connect(createLoopbackConnectOptions(target.port));
}

function connectionHeaderTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const joined = Array.isArray(value) ? value.join(",") : value;
  return new Set(
    (joined ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function proxyHeaders(headers: IncomingHttpHeaders, cookieNamespace?: string): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const connectionTokens = connectionHeaderTokens(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionTokens.has(normalized)
    ) {
      continue;
    }
    if (normalized === "cookie" && cookieNamespace !== undefined) {
      const cookie = readTargetCookies(
        Array.isArray(value) ? value.join("; ") : value,
        cookieNamespace,
      );
      if (cookie) {
        result.cookie = cookie;
      }
      continue;
    }
    // A referrer that still carries the bearer query would hand the target the
    // credential it is being kept away from; drop it rather than forward it.
    if (normalized === "referer" && String(value).includes(`${PORTAL_AUTH_NAME}=`)) {
      continue;
    }
    result[normalized] = value;
  }
  return result;
}

/** Proxies one authorized portal request to its local or worker target. */
export function handlePortalProxyRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  target: PortalProxyTarget;
  tls: boolean;
}): void {
  const { req, res, target, tls } = params;
  const authorization = authorizePortalRequest(req, target);
  if (authorization.kind === "unauthorized") {
    respondPortalUnauthorized(req, res);
    return;
  }
  if (authorization.setCookie) {
    res.setHeader("Set-Cookie", portalCookie(target, tls));
  }

  const headers = proxyHeaders(req.headers, target.cookieNamespace);
  const originalHost = req.headers.host;
  const targetPort = target.target.kind === "local" ? target.target.port : target.target.remotePort;
  headers.host = `localhost:${targetPort}`;
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  headers["x-forwarded-proto"] = tls ? "https" : "http";
  if (originalHost) {
    headers["x-forwarded-host"] = originalHost;
  }
  void connectPortalTarget(target.target).then(
    (targetSocket) => {
      if (req.aborted || res.destroyed) {
        targetSocket.destroy();
        return;
      }
      const proxyReq = requestHttp({
        hostname: "localhost",
        createConnection: () => targetSocket,
        port: targetPort,
        method: req.method,
        path: authorization.requestPath,
        headers,
      });
      proxyReq.once("response", (proxyRes) => {
        for (const [name, value] of Object.entries(proxyHeaders(proxyRes.headers))) {
          if (value !== undefined) {
            setProxyResponseHeader(res, name, value, target.cookieNamespace);
          }
        }
        // Overwrite, never default: a target answering with `unsafe-url` would otherwise
        // send the token-bearing portal URL to every third-party origin it references.
        res.setHeader("Referrer-Policy", PORTAL_REFERRER_POLICY);
        res.statusCode = proxyRes.statusCode ?? 502;
        proxyRes.once("error", () => res.destroy());
        // Streaming apps may wait for the client's open event before producing data.
        // Preserve the upstream header boundary instead of waiting for the first chunk.
        res.flushHeaders();
        proxyRes.pipe(res);
      });
      proxyReq.once("error", () => {
        if (!res.headersSent) {
          respondPortalWaiting(req, res, targetPort);
        } else {
          res.destroy();
        }
      });
      proxyReq.once("close", () => {
        if (target.target.kind === "worker" && !res.headersSent && !res.writableEnded) {
          respondPortalWaiting(req, res, targetPort);
        }
      });
      // A browser can leave after its request body ended (for example during SSE).
      res.once("close", () => proxyReq.destroy());
      req.pipe(proxyReq);
    },
    () => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        respondPortalWaiting(req, res, targetPort);
      }
    },
  );
}

function websocketHeaders(
  req: IncomingMessage,
  targetPort: number,
  cookieNamespace: string,
  requestPath: string,
): string {
  const lines = [`${req.method ?? "GET"} ${requestPath} HTTP/1.1`];
  for (const [name, value] of Object.entries(req.headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      normalized === "host" ||
      (HOP_BY_HOP_HEADERS.has(normalized) &&
        normalized !== "connection" &&
        normalized !== "upgrade")
    ) {
      continue;
    }
    if (normalized === "cookie") {
      const cookie = readTargetCookies(
        Array.isArray(value) ? value.join("; ") : value,
        cookieNamespace,
      );
      if (cookie) {
        lines.push(`cookie: ${cookie}`);
      }
      continue;
    }
    if (normalized === "referer" && String(value).includes(`${PORTAL_AUTH_NAME}=`)) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${normalized}: ${item}`);
    }
  }
  lines.push(`host: localhost:${targetPort}`, "", "");
  return lines.join("\r\n");
}

function rejectPortalUpgrade(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: 12\r\nConnection: close\r\n\r\nUnauthorized",
  );
}

function respondUpgradeWaiting(socket: Duplex, targetPort: number): void {
  const html = portalWaitingHtml(targetPort);
  socket.end(
    "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html; charset=utf-8\r\n" +
      `Cache-Control: no-store\r\nReferrer-Policy: ${PORTAL_REFERRER_POLICY}\r\n` +
      `Content-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`,
  );
}

function forwardWebSocketResponse(
  targetSocket: Duplex,
  browserSocket: Duplex,
  cookieNamespace: string,
  onResponse: () => void,
): void {
  let pending = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const headerEnd = pending.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      if (pending.length > MAX_WEBSOCKET_RESPONSE_HEADER_BYTES) {
        targetSocket.destroy();
        browserSocket.destroy();
      }
      return;
    }

    targetSocket.off("data", onData);
    const headerLines = pending.subarray(0, headerEnd).toString("latin1").split("\r\n");
    const rewrittenLines = headerLines.flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0 || line.slice(0, separator).trim().toLowerCase() !== "set-cookie") {
        return [line];
      }
      const rewritten = rewriteTargetCookie(line.slice(separator + 1).trimStart(), cookieNamespace);
      return rewritten ? [`${line.slice(0, separator)}: ${rewritten}`] : [];
    });
    onResponse();
    browserSocket.write(`${rewrittenLines.join("\r\n")}\r\n\r\n`);
    const remainder = pending.subarray(headerEnd + 4);
    if (remainder.length > 0) {
      browserSocket.write(remainder);
    }
    targetSocket.pipe(browserSocket);
  };
  targetSocket.on("data", onData);
}

/** Splices an authorized portal WebSocket upgrade into its local or worker target. */
export function handlePortalProxyUpgrade(params: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: PortalProxyTarget;
  upgradedSockets: Set<Duplex>;
}): void {
  const { req, socket, head, target, upgradedSockets } = params;
  // Node releases socket errors on upgrade; own them before replies or worker attachment.
  socket.once("error", () => socket.destroy());
  const authorization = authorizePortalRequest(req, target);
  if (authorization.kind !== "authorized") {
    rejectPortalUpgrade(socket);
    return;
  }

  const targetPort = target.target.kind === "local" ? target.target.port : target.target.remotePort;
  upgradedSockets.add(socket);
  socket.once("close", () => upgradedSockets.delete(socket));
  let responseStarted = false;
  const closeUpgrade = () => {
    if (target.target.kind === "worker" && !responseStarted && !socket.destroyed) {
      if (!socket.writableEnded) {
        respondUpgradeWaiting(socket, targetPort);
      }
      return;
    }
    socket.destroy();
  };
  void connectPortalTarget(target.target).then((targetSocket) => {
    if (socket.destroyed) {
      targetSocket.destroy();
      return;
    }
    upgradedSockets.add(targetSocket);
    socket.once("close", () => targetSocket.destroy());
    targetSocket.once("close", () => {
      upgradedSockets.delete(targetSocket);
      closeUpgrade();
    });
    targetSocket.once("end", closeUpgrade);
    targetSocket.once("error", closeUpgrade);
    const spliceUpgrade = () => {
      forwardWebSocketResponse(targetSocket, socket, target.cookieNamespace, () => {
        responseStarted = true;
      });
      targetSocket.write(
        websocketHeaders(req, targetPort, target.cookieNamespace, authorization.requestPath),
      );
      if (head.length > 0) {
        targetSocket.write(head);
      }
      socket.pipe(targetSocket);
    };
    if (target.target.kind === "worker") {
      spliceUpgrade();
    } else {
      targetSocket.once("connect", spliceUpgrade);
    }
  }, closeUpgrade);
}
