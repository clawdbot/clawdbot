import fs from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import {
  mintSecretSentinel,
  SECRET_SENTINEL_MAX_LENGTH,
  SECRET_SENTINEL_PREFIX,
} from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

type SecretEgressProxyAuditEvent = Parameters<
  typeof startSecretEgressProxyServer
>[0]["onAudit"] extends (event: infer Event) => void
  ? Event
  : never;

type OriginRequest = {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  url: string;
};

const servers: Server[] = [];
const proxies: SecretEgressProxyHandle[] = [];
const sockets = new Set<Socket>();
const tempDirs: string[] = [];
let caDir: string;
let auditEvents: SecretEgressProxyAuditEvent[];
let originRequests: OriginRequest[];
let originPort: number;
let proxy: SecretEgressProxyHandle;
let run: Readonly<{ instanceId: string; runId: string }>;
let proxyEnv: Record<string, string>;

function registerSentinel(params: {
  sentinel: string;
  allowedHosts: readonly string[];
  name?: string;
  targetProxy?: SecretEgressProxyHandle;
}): Record<string, string> {
  return (params.targetProxy ?? proxy).registerRun(run, [
    {
      name: params.name ?? "SERVICE_API_KEY",
      sentinel: params.sentinel,
      allowedHosts: params.allowedHosts,
    },
  ]);
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function basicProxyAuth(password: string): string {
  return `Basic ${Buffer.from(`openclaw:${password}`).toString("base64")}`;
}

function registeredPassword(env: Record<string, string>): string {
  const proxyUrl = env.HTTPS_PROXY;
  if (!proxyUrl) {
    throw new Error("test proxy environment is missing HTTPS_PROXY");
  }
  return new URL(proxyUrl).password;
}

async function rawConnect(params: {
  auth?: string;
  proxyOrigin?: string;
}): Promise<{ response: string; socket: Socket }> {
  const proxyUrl = new URL(params.proxyOrigin ?? proxy.proxyOrigin);
  const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const authLine = params.auth ? `Proxy-Authorization: ${params.auth}\r\n` : "";
  socket.write(
    `CONNECT localhost:${originPort} HTTP/1.1\r\nHost: localhost:${originPort}\r\n${authLine}\r\n`,
  );
  const response = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      if (buffered.includes("\r\n\r\n")) {
        socket.off("data", onData);
        resolve(buffered);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => resolve(buffered));
  });
  return { response, socket };
}

async function requestThroughTunnel(params: {
  path?: string;
  headers?: Record<string, string>;
  bodyChunks?: readonly string[];
  caPath?: string;
  proxyEnv?: Record<string, string>;
}): Promise<{ body: string; status: number }> {
  const env = params.proxyEnv ?? proxyEnv;
  const configuredProxy = env.HTTPS_PROXY;
  if (!configuredProxy) {
    throw new Error("test proxy environment is missing HTTPS_PROXY");
  }
  const connected = await rawConnect({
    auth: basicProxyAuth(registeredPassword(env)),
    proxyOrigin: new URL(configuredProxy).origin,
  });
  expect(connected.response).toContain("200 Connection Established");
  const secureSocket = tls.connect({
    socket: connected.socket,
    servername: "localhost",
    ca: fs.readFileSync(params.caPath ?? proxy.caCertPath),
  });
  await new Promise<void>((resolve, reject) => {
    secureSocket.once("secureConnect", resolve);
    secureSocket.once("error", reject);
  });
  const bodyChunks = params.bodyChunks ?? [];
  const headers = {
    Host: `localhost:${originPort}`,
    Connection: "close",
    ...(bodyChunks.length > 0 ? { "Transfer-Encoding": "chunked" } : {}),
    ...params.headers,
  };
  secureSocket.write(`POST ${params.path ?? "/"} HTTP/1.1\r\n`);
  for (const [name, value] of Object.entries(headers)) {
    secureSocket.write(`${name}: ${value}\r\n`);
  }
  secureSocket.write("\r\n");
  for (const chunk of bodyChunks) {
    secureSocket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
  }
  if (bodyChunks.length > 0) {
    secureSocket.write("0\r\n\r\n");
  }
  const raw = await new Promise<string>((resolve, reject) => {
    let output = "";
    secureSocket.setEncoding("utf8");
    secureSocket.on("data", (chunk) => {
      output += chunk.toString();
    });
    secureSocket.once("end", () => resolve(output));
    secureSocket.once("error", reject);
  });
  const [head = "", body = ""] = raw.split("\r\n\r\n", 2);
  const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(head)?.[1]);
  return { body, status };
}

async function forwardedRequest(
  auth?: string,
  protocol = "https",
  proxyOrigin = proxy.proxyOrigin,
): Promise<number> {
  const proxyUrl = new URL(proxyOrigin);
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: `${protocol}://localhost:${originPort}/forwarded-auth`,
        method: "GET",
        headers: auth ? { "Proxy-Authorization": auth } : undefined,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function tamperSentinel(sentinel: string): string {
  const index = SECRET_SENTINEL_PREFIX.length;
  const replacement = sentinel[index] === "A" ? "B" : "A";
  return `${sentinel.slice(0, index)}${replacement}${sentinel.slice(index + 1)}`;
}

beforeEach(async () => {
  auditEvents = [];
  originRequests = [];
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-egress-proxy-test-"));
  tempDirs.push(caDir);
  proxy = await startSecretEgressProxyServer({
    caDir,
    onAudit: (event) => auditEvents.push(event),
  });
  proxies.push(proxy);
  const leaf = await generateLocalProxyLeaf({
    certDir: caDir,
    ca: { certPath: proxy.caCertPath, keyPath: path.join(caDir, "root-ca-key.pem") },
    hostname: "localhost",
  });
  originPort = await listen(
    createHttpsServer(leaf, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        originRequests.push({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: { ...request.headers },
          url: request.url ?? "",
        });
        response.writeHead(200, { Connection: "close", "Content-Length": 2 });
        response.end("ok");
      });
    }),
  );
  run = Object.freeze({ instanceId: "instance-1", runId: "run-1" });
  proxyEnv = proxy.registerRun(run);
});

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  for (const currentProxy of proxies.splice(0)) {
    await currentProxy.stop();
  }
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret egress proxy", () => {
  it("activates Node environment proxy support for registered Gateway runs", () => {
    expect(proxyEnv.NODE_USE_ENV_PROXY).toBe("1");
  });

  it("survives a client that resets a refused tunnel instead of crashing the Gateway", async () => {
    // The proxy runs inside the Gateway process, so an unhandled socket 'error' would take
    // the whole Gateway down. curl resets the connection after a 407, which is exactly this.
    const proxyPort = Number(new URL(proxyEnv.HTTPS_PROXY as string).port);
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      await new Promise<void>((resolve) => {
        const socket = net.connect(proxyPort, "127.0.0.1", () => {
          // No Proxy-Authorization: the proxy answers 407, then the peer resets abruptly.
          socket.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
          setTimeout(() => {
            socket.resetAndDestroy();
            setTimeout(resolve, 150);
          }, 50);
        });
        socket.on("error", () => {});
      });
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    expect(uncaught).toEqual([]);
    // The listener must still serve traffic after the reset.
    const stillAlive = await rawConnect({ auth: basicProxyAuth(registeredPassword(proxyEnv)) });
    expect(stillAlive.response).toContain("200 Connection Established");
    stillAlive.socket.destroy();
  });

  it.each([
    { label: "missing", auth: undefined, expectedReason: "missing-proxy-auth" },
    {
      label: "malformed",
      auth: basicProxyAuth("wrong-token"),
      expectedReason: "invalid-proxy-auth",
    },
    {
      label: "wrong",
      auth: basicProxyAuth("A".repeat(43)),
      expectedReason: "invalid-proxy-auth",
    },
  ])("refuses $label authentication on CONNECT and forwarded requests", async (testCase) => {
    const connect = await rawConnect({ auth: testCase.auth });
    expect(connect.response).toContain("407 Proxy Authentication Required");
    connect.socket.destroy();

    await expect(forwardedRequest(testCase.auth)).resolves.toBe(407);
    expect(originRequests).toEqual([]);
    expect(auditEvents).toEqual([
      expect.objectContaining({ kind: "refused", reason: testCase.expectedReason }),
      expect.objectContaining({ kind: "refused", reason: testCase.expectedReason }),
    ]);
  });

  it("forwards requests without sentinels to traffic-allowlisted hosts", async () => {
    const allowedEvents: SecretEgressProxyAuditEvent[] = [];
    const allowedProxy = await startSecretEgressProxyServer({
      caDir,
      allowedHosts: ["localhost"],
      onAudit: (event) => allowedEvents.push(event),
    });
    proxies.push(allowedProxy);

    await expect(
      requestThroughTunnel({
        caPath: allowedProxy.caCertPath,
        proxyEnv: allowedProxy.registerRun(run),
      }),
    ).resolves.toMatchObject({ body: "ok", status: 200 });

    expect(originRequests).toHaveLength(1);
    expect(allowedEvents).toEqual([
      expect.objectContaining({ kind: "forwarded", host: "localhost", substituted: false }),
    ]);
  });

  it("refuses unlisted tunnels and direct requests with traffic-allowlist remediation", async () => {
    const refusedEvents: SecretEgressProxyAuditEvent[] = [];
    const restrictedProxy = await startSecretEgressProxyServer({
      caDir,
      allowedHosts: ["api.example.com"],
      onAudit: (event) => refusedEvents.push(event),
    });
    proxies.push(restrictedProxy);
    const restrictedEnv = restrictedProxy.registerRun(run);
    const auth = basicProxyAuth(registeredPassword(restrictedEnv));

    const refused = await rawConnect({ auth, proxyOrigin: restrictedProxy.proxyOrigin });
    expect(refused.response).toContain("403 Forbidden");
    expect(refused.response).toContain("secrets.egressProxy.allowedHosts");
    expect(refused.response).toContain("--allow-host localhost");
    refused.socket.destroy();

    await expect(forwardedRequest(auth, "https", restrictedProxy.proxyOrigin)).resolves.toBe(403);
    expect(originRequests).toEqual([]);
    expect(refusedEvents).toEqual([
      expect.objectContaining({ kind: "refused", host: "localhost", reason: "host-not-allowed" }),
      expect.objectContaining({ kind: "refused", host: "localhost", reason: "host-not-allowed" }),
    ]);
  });

  it("allows sentinel-bound hosts during traffic-allowlist lockdown", async () => {
    const lockdownEvents: SecretEgressProxyAuditEvent[] = [];
    const lockdownProxy = await startSecretEgressProxyServer({
      caDir,
      allowedHosts: [],
      onAudit: (event) => lockdownEvents.push(event),
    });
    proxies.push(lockdownProxy);
    const secret = "lockdown-secret-value";
    const sentinel = mintSecretSentinel(secret, { label: "egress-lockdown" });

    await expect(
      requestThroughTunnel({
        caPath: lockdownProxy.caCertPath,
        headers: { Authorization: `Bearer ${sentinel}` },
        proxyEnv: registerSentinel({
          sentinel,
          allowedHosts: ["localhost"],
          targetProxy: lockdownProxy,
        }),
      }),
    ).resolves.toMatchObject({ body: "ok", status: 200 });

    expect(originRequests.at(-1)?.headers.authorization).toBe(`Bearer ${secret}`);
    expect(lockdownEvents.at(-1)).toMatchObject({
      kind: "forwarded",
      host: "localhost",
      substituted: true,
    });
  });

  it("keeps per-secret destination bindings narrower than the traffic allowlist", async () => {
    const restrictedEvents: SecretEgressProxyAuditEvent[] = [];
    const restrictedProxy = await startSecretEgressProxyServer({
      caDir,
      allowedHosts: ["localhost"],
      onAudit: (event) => restrictedEvents.push(event),
    });
    proxies.push(restrictedProxy);
    const secret = "wrong-destination-secret";
    const sentinel = mintSecretSentinel(secret, { label: "egress-wrong-destination" });

    const result = await requestThroughTunnel({
      caPath: restrictedProxy.caCertPath,
      headers: { Authorization: `Bearer ${sentinel}` },
      proxyEnv: registerSentinel({
        sentinel,
        allowedHosts: ["api.example.com"],
        targetProxy: restrictedProxy,
      }),
    });

    expect(result.status).toBe(502);
    expect(result.body).toContain("--allow-host localhost");
    expect(originRequests).toEqual([]);
    expect(restrictedEvents.at(-1)).toMatchObject({
      kind: "refused",
      host: "localhost",
      reason: "destination-not-allowed",
    });
  });

  it("substitutes an authenticated header and strips proxy authorization upstream", async () => {
    const secret = "header-secret-value";
    const sentinel = mintSecretSentinel(secret, { label: "egress-header" });
    proxyEnv = registerSentinel({ sentinel, allowedHosts: ["LOCALHOST"] });
    expect(fs.statSync(caDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(caDir, "root-ca-key.pem")).mode & 0o777).toBe(0o600);

    await expect(
      requestThroughTunnel({ headers: { Authorization: `Bearer ${sentinel}` } }),
    ).resolves.toMatchObject({ body: "ok", status: 200 });

    expect(originRequests).toHaveLength(1);
    expect(originRequests[0]?.headers.authorization).toBe(`Bearer ${secret}`);
    expect(originRequests[0]?.headers).not.toHaveProperty("proxy-authorization");
    expect(auditEvents).toContainEqual(
      expect.objectContaining({ kind: "forwarded", host: "localhost", substituted: true }),
    );
  });

  it.each([
    { label: "an unbound host", allowedHosts: ["api.example.com"] },
    { label: "no bound hosts", allowedHosts: [] },
  ])(
    "refuses substitution for $label before the real value reaches the origin",
    async (testCase) => {
      const secret = `never-forward-${testCase.label}`;
      const sentinel = mintSecretSentinel(secret, { label: `egress-${testCase.label}` });
      proxyEnv = registerSentinel({
        sentinel,
        allowedHosts: testCase.allowedHosts,
        name: "SERVICE_API_KEY",
      });

      const result = await requestThroughTunnel({
        headers: { Authorization: `Bearer ${sentinel}` },
      });

      expect(result).toMatchObject({ status: 502 });
      expect(result.body).toContain(
        "openclaw secrets store set SERVICE_API_KEY --allow-host localhost",
      );
      expect(originRequests).toEqual([]);
      expect(JSON.stringify(originRequests)).not.toContain(secret);
      expect(auditEvents.at(-1)).toMatchObject({
        kind: "refused",
        host: "localhost",
        reason: "destination-not-allowed",
      });
    },
  );

  it.each(["url", "header", "body"] as const)(
    "refuses an unresolved sentinel in the %s",
    async (location) => {
      const unknown = tamperSentinel(
        mintSecretSentinel(`unknown-${location}`, { label: `egress-${location}` }),
      );
      const before = originRequests.length;
      const result = await requestThroughTunnel({
        path: location === "url" ? `/refuse?token=${unknown}` : "/refuse",
        headers: location === "header" ? { "X-Token": unknown } : undefined,
        bodyChunks: location === "body" ? [unknown] : undefined,
      });

      expect(result.status).toBe(502);
      expect(originRequests).toHaveLength(before);
      expect(auditEvents.at(-1)).toMatchObject({
        kind: "refused",
        reason: "unresolved-sentinel",
      });
    },
  );

  it("substitutes a streamed body larger than the maximum carry window", async () => {
    const secret = "stream-boundary-secret";
    const sentinel = mintSecretSentinel(secret, { label: "egress-stream" });
    proxyEnv = registerSentinel({ sentinel, allowedHosts: ["localhost"] });
    const split = SECRET_SENTINEL_PREFIX.length + 3;
    const prefix = "x".repeat(SECRET_SENTINEL_MAX_LENGTH + 1024);
    const suffix = "y".repeat(2048);

    await expect(
      requestThroughTunnel({
        bodyChunks: [prefix, sentinel.slice(0, split), sentinel.slice(split), suffix],
      }),
    ).resolves.toMatchObject({ status: 200 });

    expect(originRequests.at(-1)?.body).toBe(`${prefix}${secret}${suffix}`);
    expect(originRequests.at(-1)?.body).not.toContain(sentinel);
  });

  it("blind-tunnels bypassed hosts without substituting sentinels", async () => {
    const bypassEvents: SecretEgressProxyAuditEvent[] = [];
    const bypassProxy = await startSecretEgressProxyServer({
      caDir: fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-egress-bypass-test-")),
      bypassHosts: ["localhost"],
      onAudit: (event) => bypassEvents.push(event),
    });
    proxies.push(bypassProxy);
    tempDirs.push(path.dirname(bypassProxy.caCertPath));
    const bypassEnv = bypassProxy.registerRun(run);
    const sentinel = mintSecretSentinel("bypass-secret", { label: "egress-bypass" });

    await expect(
      requestThroughTunnel({
        caPath: proxy.caCertPath,
        headers: { Authorization: `Bearer ${sentinel}` },
        proxyEnv: bypassEnv,
      }),
    ).resolves.toMatchObject({ status: 200 });

    expect(originRequests.at(-1)?.headers.authorization).toBe(`Bearer ${sentinel}`);
    expect(bypassEvents).toEqual([
      expect.objectContaining({
        kind: "forwarded",
        reason: "bypass",
        substituted: false,
      }),
    ]);
  });

  it("revokes Basic authorization with the exact owning run and keeps audits payload-free", async () => {
    const secret = "audit-secret-value";
    const sentinel = mintSecretSentinel(secret, { label: "egress-audit" });
    proxyEnv = registerSentinel({ sentinel, allowedHosts: ["localhost"] });
    await requestThroughTunnel({ headers: { "X-Secret": sentinel } });
    await expect(
      forwardedRequest(basicProxyAuth(registeredPassword(proxyEnv)), "http"),
    ).resolves.toBe(502);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({ kind: "refused", reason: "non-https-request" }),
    );

    proxy.revokeRun(run);
    const refused = await rawConnect({
      auth: basicProxyAuth(registeredPassword(proxyEnv)),
    });
    expect(refused.response).toContain("407 Proxy Authentication Required");
    refused.socket.destroy();

    const auditText = JSON.stringify(auditEvents);
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain(sentinel);
  });
});
