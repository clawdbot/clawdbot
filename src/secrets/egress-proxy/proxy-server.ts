import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import {
  Agent as HttpsAgent,
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server as HttpsServer,
} from "node:https";
import net, { type Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { rootCertificates } from "node:tls";
import { domainToASCII, URL } from "node:url";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import {
  containsSecretSentinel,
  resolveSecretSentinel,
  SECRET_SENTINEL_PATTERN,
} from "../sentinel.js";
import {
  createSecretEgressBodyTransform,
  SecretEgressSubstitutionError,
  type SecretEgressRefusalReason,
} from "./stream-substitution.js";

const PROXY_AUTH_USERNAME = "openclaw";
const PROXY_AUTH_REALM = "OpenClaw secret egress";
const REFUSAL_BODY = "Secret egress proxy refused the request.\n";
const UPSTREAM_ERROR_BODY = "Secret egress proxy could not reach the upstream host.\n";

type SecretEgressProxyAuditEvent = {
  kind: "forwarded" | "refused";
  host: string;
  substituted: boolean;
  reason?: SecretEgressRefusalReason | "bypass";
};

export type SecretEgressSentinelBinding = Readonly<{
  name: string;
  sentinel: string;
  allowedHosts: readonly string[];
}>;

export type SecretEgressProxyHandle = {
  caCertPath: string;
  proxyOrigin: string;
  registerRun: (
    run: Readonly<{ instanceId: string; runId: string }>,
    bindings?: readonly SecretEgressSentinelBinding[],
  ) => Record<string, string>;
  revokeRun: (run: Readonly<{ instanceId: string; runId: string }>) => void;
  stop: () => Promise<void>;
};

type ConnectTarget = { hostname: string; port: number };
type RegisteredRun = {
  digest: Buffer;
  key: string;
  sentinelBindings: Map<string, { allowedHosts: Set<string>; name: string }>;
  token: string;
};

function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/, "");
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (net.isIP(unbracketed)) {
    return unbracketed;
  }
  const ascii = domainToASCII(unbracketed);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii
      .split(".")
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          label.startsWith("-") ||
          label.endsWith("-") ||
          !/^[a-z0-9-]+$/u.test(label),
      )
  ) {
    throw new Error("Invalid proxy target hostname");
  }
  return ascii;
}

function parseConnectTarget(rawTarget: string | undefined): ConnectTarget {
  const raw = rawTarget?.trim();
  if (!raw || /[\r\n]/u.test(raw)) {
    throw new Error("Invalid CONNECT target");
  }
  const target = new URL(`https://${raw}`);
  if (
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  ) {
    throw new Error("Invalid CONNECT target");
  }
  const port = target.port ? Number(target.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid CONNECT target port");
  }
  return { hostname: normalizeHostname(target.hostname), port };
}

function runKey(run: Readonly<{ instanceId: string; runId: string }>): string {
  return `${run.runId}\0${run.instanceId}`;
}

// Proxy tokens are 256-bit random bearer credentials, not user-chosen passwords, so a
// slow KDF would add per-request latency on the proxy hot path without making brute force
// any more infeasible. A process-keyed MAC is the right primitive: it normalizes attacker-
// controlled input to a fixed length for constant-time compare, and a leaked digest cannot
// be correlated back to a token without the in-memory key.
const tokenMacKey = randomBytes(32);

function tokenDigest(token: string): Buffer {
  return createHmac("sha256", tokenMacKey).update(token).digest();
}

function parseBasicProxyPassword(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/iu.exec(header.trim());
  if (!match?.[1]) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1 || decoded.slice(0, colon) !== PROXY_AUTH_USERNAME) {
    return undefined;
  }
  return decoded.slice(colon + 1);
}

function sendProxyAuthRequired(socket: Duplex): void {
  socket.end(
    `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(REFUSAL_BODY)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${REFUSAL_BODY}`,
  );
}

function sendHttpRefusal(res: ServerResponse, status = 502, body = REFUSAL_BODY): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    Connection: "close",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(body);
}

function resolveRegisteredSentinel(params: {
  sentinel: string;
  host: string;
  registered: RegisteredRun;
}): string | undefined {
  const binding = params.registered.sentinelBindings.get(params.sentinel);
  if (!binding) {
    return undefined;
  }
  if (!binding.allowedHosts.has(params.host)) {
    throw new SecretEgressSubstitutionError("destination-not-allowed", {
      host: params.host,
      secretName: binding.name,
    });
  }
  return resolveSecretSentinel(params.sentinel);
}

function swapRequestText(params: {
  value: string;
  urlMode: boolean;
  host: string;
  registered: RegisteredRun;
}): { value: string; substituted: boolean } {
  if (!containsSecretSentinel(params.value)) {
    return { value: params.value, substituted: false };
  }
  let substituted = false;
  const swapped = params.value.replace(
    new RegExp(SECRET_SENTINEL_PATTERN.source, "g"),
    (sentinel) => {
      const resolved = resolveRegisteredSentinel({
        sentinel,
        host: params.host,
        registered: params.registered,
      });
      if (resolved === undefined) {
        return sentinel;
      }
      substituted = true;
      return params.urlMode ? encodeURIComponent(resolved) : resolved;
    },
  );
  if (containsSecretSentinel(swapped)) {
    throw new SecretEgressSubstitutionError("unresolved-sentinel");
  }
  return { value: swapped, substituted };
}

function swapRequestHeaders(params: {
  headers: IncomingHttpHeaders;
  host: string;
  registered: RegisteredRun;
}): {
  headers: IncomingHttpHeaders;
  substituted: boolean;
} {
  const output: IncomingHttpHeaders = {};
  let substituted = false;
  for (const [name, rawValue] of Object.entries(params.headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === "proxy-authorization" || lowerName === "proxy-connection") {
      continue;
    }
    if (Array.isArray(rawValue)) {
      output[name] = rawValue.map((value) => {
        const swapped = swapRequestText({
          value,
          urlMode: false,
          host: params.host,
          registered: params.registered,
        });
        substituted ||= swapped.substituted;
        return swapped.value;
      });
      continue;
    }
    if (rawValue !== undefined) {
      const swapped = swapRequestText({
        value: rawValue,
        urlMode: false,
        host: params.host,
        registered: params.registered,
      });
      substituted ||= swapped.substituted;
      output[name] = swapped.value;
    }
  }
  delete output["content-length"];
  delete output["transfer-encoding"];
  return { headers: output, substituted };
}

function createUpstreamRequestOptions(params: {
  target: URL;
  request: IncomingMessage;
  headers: IncomingHttpHeaders;
}): RequestOptions {
  return {
    hostname: params.target.hostname,
    port: params.target.port || (params.target.protocol === "https:" ? 443 : 80),
    path: `${params.target.pathname}${params.target.search}`,
    method: params.request.method,
    headers: params.headers,
  };
}

/** Starts one authenticated, loopback-only substitution proxy. */
export async function startSecretEgressProxyServer(params: {
  caDir: string;
  bypassHosts?: readonly string[];
  onAudit: (event: SecretEgressProxyAuditEvent) => void;
}): Promise<SecretEgressProxyHandle> {
  const ca = await ensureSecretEgressProxyCa(params.caDir);
  const caPem = fs.readFileSync(ca.certPath, "utf8");
  const trustBundlePath = path.join(params.caDir, "trust-bundle.pem");
  fs.writeFileSync(trustBundlePath, `${rootCertificates.join("\n")}\n${caPem}`, { mode: 0o644 });
  const upstreamTlsAgent = new HttpsAgent({
    ca: [...rootCertificates, caPem],
  });
  const bypassHosts = new Set((params.bypassHosts ?? []).map(normalizeHostname));
  const tokens = new Map<string, RegisteredRun>();
  const sockets = new Set<Socket>();
  const tlsServers = new Map<string, Promise<HttpsServer>>();

  const audit = (event: SecretEgressProxyAuditEvent) => params.onAudit(event);
  const authorize = (
    headers: IncomingHttpHeaders,
  ): RegisteredRun | Exclude<SecretEgressRefusalReason, "destination-not-allowed"> => {
    const rawHeader = headers["proxy-authorization"];
    if (rawHeader === undefined) {
      return "missing-proxy-auth";
    }
    const password = parseBasicProxyPassword(rawHeader);
    if (!password) {
      return "invalid-proxy-auth";
    }
    const candidate = tokenDigest(password);
    for (const registered of tokens.values()) {
      if (timingSafeEqual(candidate, registered.digest)) {
        return registered;
      }
    }
    return "invalid-proxy-auth";
  };

  const forwardRequest = (forward: {
    request: IncomingMessage;
    response: ServerResponse;
    target: URL;
    registered: RegisteredRun;
  }) => {
    const host = normalizeHostname(forward.target.hostname);
    if (forward.target.protocol !== "https:") {
      audit({
        kind: "refused",
        host,
        substituted: false,
        reason: "non-https-request",
      });
      sendHttpRefusal(forward.response);
      forward.request.resume();
      return;
    }
    let substituted = false;
    let target: URL;
    let headers: IncomingHttpHeaders;
    try {
      const swappedUrl = swapRequestText({
        value: forward.target.toString(),
        urlMode: true,
        host,
        registered: forward.registered,
      });
      target = new URL(swappedUrl.value);
      const swappedHeaders = swapRequestHeaders({
        headers: forward.request.headers,
        host,
        registered: forward.registered,
      });
      headers = swappedHeaders.headers;
      headers.host = target.host;
      substituted = swappedUrl.substituted || swappedHeaders.substituted;
    } catch (error) {
      const reason =
        error instanceof SecretEgressSubstitutionError ? error.reason : "unresolved-sentinel";
      audit({ kind: "refused", host, substituted, reason });
      sendHttpRefusal(
        forward.response,
        502,
        error instanceof SecretEgressSubstitutionError ? `${error.message}\n` : REFUSAL_BODY,
      );
      forward.request.resume();
      return;
    }

    const bodyTransform = createSecretEgressBodyTransform({
      onSubstitution: () => {
        substituted = true;
      },
      resolveSentinel: (sentinel) =>
        resolveRegisteredSentinel({ sentinel, host, registered: forward.registered }),
    });
    let refused = false;
    let forwardedLogged = false;
    const requestOptions = createUpstreamRequestOptions({
      target,
      request: forward.request,
      headers,
    });
    const upstream = httpsRequest(
      {
        ...requestOptions,
        agent: upstreamTlsAgent,
      },
      (upstreamResponse) => {
        if (refused) {
          upstreamResponse.destroy();
          return;
        }
        forward.response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(forward.response);
      },
    );
    bodyTransform.once("finish", () => {
      if (!refused && !forwardedLogged) {
        forwardedLogged = true;
        audit({ kind: "forwarded", host, substituted });
      }
    });
    bodyTransform.once("error", (error) => {
      if (refused) {
        return;
      }
      refused = true;
      forward.request.unpipe(bodyTransform);
      forward.request.resume();
      upstream.destroy();
      const reason =
        error instanceof SecretEgressSubstitutionError ? error.reason : "unresolved-sentinel";
      audit({ kind: "refused", host, substituted, reason });
      sendHttpRefusal(
        forward.response,
        502,
        error instanceof SecretEgressSubstitutionError ? `${error.message}\n` : REFUSAL_BODY,
      );
    });
    upstream.once("error", () => {
      if (refused) {
        return;
      }
      refused = true;
      audit({ kind: "refused", host, substituted, reason: "upstream-error" });
      sendHttpRefusal(forward.response, 502, UPSTREAM_ERROR_BODY);
    });
    forward.request.pipe(bodyTransform).pipe(upstream);
  };

  const tlsServerFor = (target: ConnectTarget, registered: RegisteredRun): Promise<HttpsServer> => {
    const key = `${registered.key}\0${target.hostname}:${target.port}`;
    let server = tlsServers.get(key);
    if (!server) {
      server = generateLocalProxyLeaf({
        certDir: params.caDir,
        ca,
        hostname: target.hostname,
      }).then((leaf) =>
        createHttpsServer(leaf, (request, response) => {
          const targetUrl = new URL(
            request.url ?? "/",
            `https://${target.hostname}${target.port === 443 ? "" : `:${target.port}`}`,
          );
          forwardRequest({ request, response, target: targetUrl, registered });
        }),
      );
      tlsServers.set(key, server);
    }
    return server;
  };

  const proxy = createHttpServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      audit({
        kind: "refused",
        host: request.headers.host ?? "unknown",
        substituted: false,
        reason: "upstream-error",
      });
      sendHttpRefusal(response, 400);
      return;
    }
    const host = normalizeHostname(target.hostname);
    const authorization = authorize(request.headers);
    if (typeof authorization === "string") {
      audit({ kind: "refused", host, substituted: false, reason: authorization });
      response.writeHead(407, {
        "Proxy-Authenticate": `Basic realm="${PROXY_AUTH_REALM}"`,
        Connection: "close",
        "Content-Length": Buffer.byteLength(REFUSAL_BODY),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(REFUSAL_BODY);
      request.resume();
      return;
    }
    forwardRequest({ request, response, target, registered: authorization });
  });

  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // The proxy runs inside the Gateway process, so an unhandled socket 'error' would
    // take the Gateway down. Clients legitimately reset refused tunnels (curl does this
    // after a 407), so peer resets are expected and must stay local to the socket.
    socket.on("error", () => {
      socket.destroy();
    });
  });
  proxy.on("connect", (request, clientSocket, head) => {
    void (async () => {
      let target: ConnectTarget;
      try {
        target = parseConnectTarget(request.url);
      } catch {
        audit({ kind: "refused", host: "unknown", substituted: false, reason: "upstream-error" });
        clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      const authorization = authorize(request.headers);
      if (typeof authorization === "string") {
        audit({
          kind: "refused",
          host: target.hostname,
          substituted: false,
          reason: authorization,
        });
        sendProxyAuthRequired(clientSocket);
        return;
      }
      if (bypassHosts.has(target.hostname)) {
        const upstream = net.connect(target.port, target.hostname, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) {
            upstream.write(head);
          }
          clientSocket.pipe(upstream).pipe(clientSocket);
          audit({
            kind: "forwarded",
            host: target.hostname,
            substituted: false,
            reason: "bypass",
          });
        });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.once("error", () => clientSocket.destroy());
        return;
      }
      try {
        const tlsServer = await tlsServerFor(target, authorization);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          clientSocket.unshift(head);
        }
        tlsServer.emit("connection", clientSocket);
      } catch {
        audit({
          kind: "refused",
          host: target.hostname,
          substituted: false,
          reason: "upstream-error",
        });
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.off("error", reject);
      resolve();
    });
  });
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("Secret egress proxy failed to bind loopback");
  }
  const proxyOrigin = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  return {
    caCertPath: ca.certPath,
    proxyOrigin,
    registerRun: (run, bindings = []) => {
      const key = runKey(run);
      let registered = tokens.get(key);
      if (!registered) {
        const token = randomBytes(32).toString("base64url");
        registered = {
          digest: tokenDigest(token),
          key,
          sentinelBindings: new Map(),
          token,
        };
        tokens.set(key, registered);
      }
      registered.sentinelBindings = new Map(
        bindings.map((binding) => [
          binding.sentinel,
          {
            allowedHosts: new Set(binding.allowedHosts.map(normalizeHostname)),
            name: binding.name,
          },
        ]),
      );
      // Basic is deliberately used because curl and Go net/http derive it from
      // proxy-URL credentials. Base64 is acceptable here: loopback is the only
      // listener, the token is run-scoped, and a process that can read it from
      // this env can already read the sentinels that authorize substitution.
      const proxyUrl = `http://${PROXY_AUTH_USERNAME}:${registered.token}@127.0.0.1:${address.port}`;
      return {
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        NODE_USE_ENV_PROXY: "1",
        NODE_EXTRA_CA_CERTS: trustBundlePath,
        SSL_CERT_FILE: trustBundlePath,
        CURL_CA_BUNDLE: trustBundlePath,
        REQUESTS_CA_BUNDLE: trustBundlePath,
      };
    },
    revokeRun: (run) => {
      tokens.delete(runKey(run));
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      tokens.clear();
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      });
    },
  };
}
