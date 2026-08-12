import { timingSafeEqual } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { request as requestHttp } from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";

const PORTAL_AUTH_NAME = "openclaw_portal";
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

export type PortalProxyTarget = {
  targetPort: number;
  token: string;
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

function readPortalCookie(cookieHeader: string | undefined): string | undefined {
  for (const segment of cookieHeader?.split(";") ?? []) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== PORTAL_AUTH_NAME) {
      continue;
    }
    return segment.slice(separator + 1).trim();
  }
  return undefined;
}

function stripPortalCookie(cookieHeader: string | undefined): string | undefined {
  const retained = (cookieHeader?.split(";") ?? []).filter((segment) => {
    const separator = segment.indexOf("=");
    return separator < 0 || segment.slice(0, separator).trim() !== PORTAL_AUTH_NAME;
  });
  const normalized = retained
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("; ");
  return normalized || undefined;
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
  if (tokensEqual(readPortalCookie(req.headers.cookie), target.token)) {
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
  return `${PORTAL_AUTH_NAME}=${target.token}; HttpOnly; SameSite=Lax; Path=/${tls ? "; Secure" : ""}`;
}

function setProxyResponseHeader(
  res: ServerResponse,
  name: string,
  value: string | string[] | number,
): void {
  if (name !== "set-cookie") {
    res.setHeader(name, value);
    return;
  }
  const existing = res.getHeader("Set-Cookie");
  const existingCookies =
    existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  const targetCookies = Array.isArray(value) ? value : [String(value)];
  res.setHeader("Set-Cookie", [...existingCookies.map(String), ...targetCookies]);
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
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(headOnly ? undefined : html);
}

function respondPortalUnauthorized(req: IncomingMessage, res: ServerResponse): void {
  const html =
    "<!doctype html><meta charset=utf-8><title>Private portal</title>" +
    "<p>This portal is private. Open it from the OpenClaw Control UI.</p>";
  htmlResponse(res, 401, html, req.method === "HEAD");
}

function respondPortalWaiting(req: IncomingMessage, res: ServerResponse, targetPort: number): void {
  const html =
    '<!doctype html><meta charset=utf-8><meta http-equiv="refresh" content="2">' +
    `<title>Waiting for app</title><p>Waiting for the app on port ${targetPort}…</p>`;
  htmlResponse(res, 502, html, req.method === "HEAD");
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

function proxyHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
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
    if (normalized === "cookie") {
      const cookie = stripPortalCookie(Array.isArray(value) ? value.join("; ") : value);
      if (cookie) {
        result.cookie = cookie;
      }
      continue;
    }
    result[normalized] = value;
  }
  return result;
}

/** Proxies one authorized portal request only to the loopback target. */
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

  const headers = proxyHeaders(req.headers);
  const originalHost = req.headers.host;
  headers.host = `127.0.0.1:${target.targetPort}`;
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  headers["x-forwarded-proto"] = tls ? "https" : "http";
  if (originalHost) {
    headers["x-forwarded-host"] = originalHost;
  }
  const proxyReq = requestHttp({
    hostname: "127.0.0.1",
    port: target.targetPort,
    method: req.method,
    path: authorization.requestPath,
    headers,
  });
  proxyReq.once("response", (proxyRes) => {
    for (const [name, value] of Object.entries(proxyHeaders(proxyRes.headers))) {
      if (value !== undefined) {
        setProxyResponseHeader(res, name, value);
      }
    }
    res.statusCode = proxyRes.statusCode ?? 502;
    proxyRes.pipe(res);
  });
  proxyReq.once("error", () => {
    if (!res.headersSent) {
      respondPortalWaiting(req, res, target.targetPort);
    } else {
      res.destroy();
    }
  });
  req.once("aborted", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function websocketHeaders(req: IncomingMessage, targetPort: number, requestPath: string): string {
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
      const cookie = stripPortalCookie(Array.isArray(value) ? value.join("; ") : value);
      if (cookie) {
        lines.push(`cookie: ${cookie}`);
      }
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${normalized}: ${item}`);
    }
  }
  lines.push(`host: 127.0.0.1:${targetPort}`, "", "");
  return lines.join("\r\n");
}

function rejectPortalUpgrade(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: 12\r\nConnection: close\r\n\r\nUnauthorized",
  );
}

/** Splices an authorized portal WebSocket upgrade into the loopback target. */
export function handlePortalProxyUpgrade(params: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: PortalProxyTarget;
  upgradedSockets: Set<Duplex>;
}): void {
  const { req, socket, head, target, upgradedSockets } = params;
  const authorization = authorizePortalRequest(req, target);
  if (authorization.kind !== "authorized") {
    rejectPortalUpgrade(socket);
    return;
  }

  const targetSocket: Socket = net.connect({ host: "127.0.0.1", port: target.targetPort });
  upgradedSockets.add(socket);
  upgradedSockets.add(targetSocket);
  const release = (stream: Duplex) => upgradedSockets.delete(stream);
  socket.once("close", () => {
    release(socket);
    targetSocket.destroy();
  });
  targetSocket.once("close", () => {
    release(targetSocket);
    socket.destroy();
  });
  socket.once("error", () => targetSocket.destroy());
  targetSocket.once("error", () => socket.destroy());
  targetSocket.once("connect", () => {
    targetSocket.write(websocketHeaders(req, target.targetPort, authorization.requestPath));
    if (head.length > 0) {
      targetSocket.write(head);
    }
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });
}
