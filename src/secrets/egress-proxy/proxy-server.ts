import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  Agent as HttpsAgent,
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import net, { type Socket } from "node:net";
import path from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { rootCertificates } from "node:tls";
import { URL } from "node:url";
import { normalizeExactAllowedHost as normalizeHostname } from "../exact-hostname.js";
import {
  containsSecretSentinel,
  resolveSecretSentinel,
  SECRET_SENTINEL_PATTERN,
} from "../sentinel.js";
import {
  createSecretEgressCertificates,
  SecretEgressCertificateError,
  type SecretEgressCertificateStatus,
  type SecretEgressTlsContext,
} from "./certificates.js";
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
  reason?: SecretEgressRefusalReason | "bypass" | "certificate-error";
};

export type SecretEgressSentinelBinding = Readonly<{
  name: string;
  sentinel: string;
  allowedHosts: readonly string[];
}>;

export type SecretEgressProxyHandle = {
  caCertPath: string;
  proxyOrigin: string;
  getCertificateStatus: () => SecretEgressCertificateStatus;
  registerRun: (
    run: Readonly<{ instanceId: string; runId: string }>,
    bindings?: readonly SecretEgressSentinelBinding[],
  ) => Record<string, string>;
  revokeRun: (run: Readonly<{ instanceId: string; runId: string }>) => void;
  stop: () => Promise<void>;
};

type ConnectTarget = { hostname: string; port: number };
type RegisteredRun = {
  key: string;
  sentinelBindings: Map<string, { allowedHosts: Set<string>; name: string }>;
  token: Buffer;
  isActive: () => boolean;
  resources: Set<Readable | Writable>;
  tlsServers: Map<string, SecretEgressTlsContext>;
};

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

function parseProxyToken(token: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    return undefined;
  }
  const bytes = Buffer.from(token, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === token ? bytes : undefined;
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
  if (!params.registered.isActive()) {
    return undefined;
  }
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

/** Starts one authenticated, loopback-only substitution proxy. */
export async function startSecretEgressProxyServer(params: {
  caDir: string;
  allowedHosts?: readonly string[];
  bypassHosts?: readonly string[];
  onAudit: (event: SecretEgressProxyAuditEvent) => void;
}): Promise<SecretEgressProxyHandle> {
  const certificates = await createSecretEgressCertificates(params.caDir);
  const { caPem } = certificates;
  const trustBundlePath = path.join(params.caDir, "trust-bundle.pem");
  fs.writeFileSync(trustBundlePath, `${rootCertificates.join("\n")}\n${caPem}`, { mode: 0o644 });
  const upstreamTlsAgent = new HttpsAgent({
    ca: [...rootCertificates, caPem],
  });
  const bypassHosts = new Set((params.bypassHosts ?? []).map(normalizeHostname));
  const allowedHosts =
    params.allowedHosts === undefined
      ? undefined
      : new Set(params.allowedHosts.map(normalizeHostname));
  const registrations = new Map<string, RegisteredRun>();
  const sockets = new Set<Socket>();
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  const ownResource = <T extends Readable | Writable>(
    registered: RegisteredRun,
    resource: T,
  ): T => {
    if (!registered.resources.has(resource)) {
      registered.resources.add(resource);
      resource.once("close", () => registered.resources.delete(resource));
      // Revocation aborts HTTP/TLS streams as well as raw sockets. Their expected
      // reset errors must stay local instead of becoming uncaught Gateway errors.
      resource.on("error", () => resource.destroy());
    }
    if (!registered.isActive()) {
      resource.destroy();
    }
    return resource;
  };
  const revokeRegistration = (registered: RegisteredRun) => {
    registrations.delete(registered.key);
    registered.sentinelBindings.clear();
    for (const resource of registered.resources) {
      resource.destroy();
    }
    registered.resources.clear();
    for (const server of registered.tlsServers.values()) {
      server.close();
    }
    registered.tlsServers.clear();
  };

  const audit = (event: SecretEgressProxyAuditEvent) => params.onAudit(event);
  const hostAllowed = (host: string, registered: RegisteredRun): boolean => {
    if (allowedHosts === undefined || allowedHosts.has(host) || bypassHosts.has(host)) {
      return true;
    }
    for (const binding of registered.sentinelBindings.values()) {
      if (binding.allowedHosts.has(host)) {
        return true;
      }
    }
    return false;
  };
  const hostNotAllowedBody = (host: string): string =>
    `Host "${host}" is not in the secret egress proxy traffic allowlist. Add it to secrets.egressProxy.allowedHosts or bind a store secret to it with: openclaw secrets store set <NAME> --allow-host ${host}, then restart the Gateway.\n`;
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
    const candidate = parseProxyToken(password);
    if (!candidate) {
      return "invalid-proxy-auth";
    }
    for (const registered of registrations.values()) {
      if (timingSafeEqual(candidate, registered.token)) {
        return registered;
      }
    }
    return "invalid-proxy-auth";
  };

  const parseRequestTarget = (
    request: IncomingMessage,
    response: ServerResponse,
    base?: string,
  ): { target: URL; host: string } | undefined => {
    try {
      const target = new URL(request.url ?? "/", base);
      return { target, host: normalizeHostname(target.hostname) };
    } catch {
      // URL accepts hostnames our exact-host policy rejects. Both checks must
      // stay inside refusal handling for direct requests and decrypted tunnels.
      audit({ kind: "refused", host: "unknown", substituted: false, reason: "upstream-error" });
      sendHttpRefusal(response, 400);
      request.resume();
      return undefined;
    }
  };

  const forwardRequest = (forward: {
    request: IncomingMessage;
    response: ServerResponse;
    target: URL;
    host: string;
    registered: RegisteredRun;
  }) => {
    ownResource(forward.registered, forward.request);
    ownResource(forward.registered, forward.response);
    if (!forward.registered.isActive()) {
      return;
    }
    const { host } = forward;
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
    if (!hostAllowed(host, forward.registered)) {
      audit({ kind: "refused", host, substituted: false, reason: "host-not-allowed" });
      sendHttpRefusal(forward.response, 403, hostNotAllowedBody(host));
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

    const bodyTransform = ownResource(
      forward.registered,
      createSecretEgressBodyTransform({
        onSubstitution: () => {
          substituted = true;
        },
        resolveSentinel: (sentinel) =>
          resolveRegisteredSentinel({ sentinel, host, registered: forward.registered }),
      }),
    );
    let refused = false;
    const upstream = ownResource(
      forward.registered,
      httpsRequest(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: forward.request.method,
          headers,
          agent: upstreamTlsAgent,
        },
        (upstreamResponse) => {
          ownResource(forward.registered, upstreamResponse);
          if (refused || !forward.registered.isActive()) {
            upstreamResponse.destroy();
            return;
          }
          upstreamResponse.once("error", () => forward.response.destroy());
          forward.response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(forward.response);
        },
      ),
    );
    forward.request.once("error", () => forward.response.destroy());
    forward.response.once("close", () => {
      refused = true;
      forward.request.unpipe(bodyTransform);
      bodyTransform.destroy();
      upstream.destroy();
    });
    bodyTransform.once("finish", () => {
      if (!refused && forward.registered.isActive()) {
        audit({ kind: "forwarded", host, substituted });
      }
    });
    bodyTransform.once("error", (error) => {
      if (refused || !forward.registered.isActive()) {
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
      if (refused || !forward.registered.isActive()) {
        return;
      }
      refused = true;
      audit({ kind: "refused", host, substituted, reason: "upstream-error" });
      sendHttpRefusal(forward.response, 502, UPSTREAM_ERROR_BODY);
    });
    forward.request.pipe(bodyTransform).pipe(upstream);
  };

  const tlsServerFor = (target: ConnectTarget, registered: RegisteredRun) => {
    const key = `${target.hostname}:${target.port}`;
    let context = registered.tlsServers.get(key);
    if (!context) {
      context = certificates.createContext({
        hostname: target.hostname,
        isActive: registered.isActive,
        createServer: (leaf) =>
          createHttpsServer(leaf, (request, response) => {
            const parsed = parseRequestTarget(
              request,
              response,
              `https://${target.hostname}${target.port === 443 ? "" : `:${target.port}`}`,
            );
            if (parsed) {
              forwardRequest({ request, response, ...parsed, registered });
            }
          }).on("secureConnection", (socket) => ownResource(registered, socket)),
      });
      registered.tlsServers.set(key, context);
    }
    return context.get();
  };

  const proxy = createHttpServer((request, response) => {
    const parsed = parseRequestTarget(request, response);
    if (!parsed) {
      return;
    }
    const { host } = parsed;
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
    forwardRequest({ request, response, ...parsed, registered: authorization });
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
      ownResource(authorization, clientSocket);
      if (bypassHosts.has(target.hostname)) {
        const upstream = ownResource(
          authorization,
          net.connect(target.port, target.hostname, () => {
            if (!authorization.isActive() || clientSocket.destroyed) {
              upstream.destroy();
              return;
            }
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
          }),
        );
        clientSocket.once("close", () => upstream.destroy());
        upstream.once("close", () => clientSocket.destroy());
        upstream.once("error", () => clientSocket.destroy());
        return;
      }
      if (!hostAllowed(target.hostname, authorization)) {
        const body = hostNotAllowedBody(target.hostname);
        audit({
          kind: "refused",
          host: target.hostname,
          substituted: false,
          reason: "host-not-allowed",
        });
        clientSocket.end(
          `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
        );
        return;
      }
      try {
        const tlsServer = await tlsServerFor(target, authorization);
        if (!tlsServer || !authorization.isActive() || clientSocket.destroyed) {
          clientSocket.destroy();
          return;
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          clientSocket.unshift(head);
        }
        tlsServer.emit("connection", clientSocket);
      } catch (error) {
        if (!authorization.isActive() || clientSocket.destroyed) {
          return;
        }
        audit({
          kind: "refused",
          host: target.hostname,
          substituted: false,
          reason: "certificate-error",
        });
        const body = `${error instanceof SecretEgressCertificateError ? error.message : "Secret egress TLS certificate unavailable. Check Gateway logs, then retry."}\n`;
        clientSocket.end(
          `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
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
  return {
    caCertPath: certificates.caCertPath,
    proxyOrigin,
    getCertificateStatus: certificates.getStatus,
    registerRun: (run, bindings = []) => {
      if (stopped) {
        throw new Error("Secret egress proxy has stopped");
      }
      const key = runKey(run);
      let registered = registrations.get(key);
      if (!registered) {
        registered = {
          key,
          sentinelBindings: new Map(),
          token: randomBytes(32),
          isActive: () => !stopped && registrations.get(key) === registered,
          resources: new Set(),
          tlsServers: new Map(),
        };
        registrations.set(key, registered);
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
      const token = registered.token.toString("base64url");
      const proxyUrl = `http://${PROXY_AUTH_USERNAME}:${token}@127.0.0.1:${address.port}`;
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
      const registered = registrations.get(runKey(run));
      if (registered) {
        revokeRegistration(registered);
      }
    },
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      for (const registered of registrations.values()) {
        revokeRegistration(registered);
      }
      upstreamTlsAgent.destroy();
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      // The runtime removes the CA directory after stop; let already-started
      // leaf jobs finish without ever admitting their revoked connections.
      stopPromise = Promise.all([
        new Promise<void>((resolve) => {
          proxy.close(() => resolve());
        }),
        certificates.waitForPreparations(),
      ]).then(() => {});
      return stopPromise;
    },
  };
}
