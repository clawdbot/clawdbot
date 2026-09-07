import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as proxyCa from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { mintSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

const run = { instanceId: "instance-1", runId: "run-1" };
const sibling = { instanceId: "instance-2", runId: "run-2" };
const value = "synthetic-lifecycle-credential";
let caDir: string;
let proxy: SecretEgressProxyHandle;
let origin: Server;
let originPort: number;
let sentinel: string;
let proxyEnv: Record<string, string>;
let observed: Array<{ authorization: string | undefined; body: string }>;
const sockets = new Set<Socket>();

function trackSocket<T extends Socket>(socket: T): T {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

function connectTunnel(env = proxyEnv): Promise<{ status: number; socket?: Socket }> {
  const url = new URL(env.HTTPS_PROXY!);
  return new Promise((resolve) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      method: "CONNECT",
      path: `localhost:${originPort}`,
      headers: {
        "Proxy-Authorization": `Basic ${Buffer.from(`openclaw:${url.password}`).toString("base64")}`,
      },
    });
    request.once("socket", trackSocket);
    request.once("connect", (response, socket) => {
      resolve({ status: response.statusCode ?? 0, socket: trackSocket(socket) });
    });
    request.once("error", () => resolve({ status: 0 }));
    request.end();
  });
}

async function openTlsTunnel(env = proxyEnv): Promise<tls.TLSSocket> {
  const connected = await connectTunnel(env);
  expect(connected.status).toBe(200);
  const socket = trackSocket(
    tls.connect({
      socket: connected.socket,
      servername: "localhost",
      ca: fs.readFileSync(proxy.caCertPath),
    }),
  );
  await once(socket, "secureConnect");
  socket.resume();
  return socket;
}

function onClose(socket: Socket | IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

async function sendCredential(socket: tls.TLSSocket): Promise<void> {
  const closed = onClose(socket);
  socket.write(
    `GET / HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\nAuthorization: Bearer ${sentinel}\r\n\r\n`,
  );
  await closed;
}

function register(targetRun = run): Record<string, string> {
  return proxy.registerRun(targetRun, [
    { name: "SERVICE_API_KEY", sentinel, allowedHosts: ["localhost"] },
  ]);
}

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", undefined);
  observed = [];
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-egress-lifecycle-"));
  proxy = await startSecretEgressProxyServer({ caDir, onAudit: () => {} });
  const leaf = await proxyCa.generateLocalProxyLeaf({
    certDir: caDir,
    ca: { certPath: proxy.caCertPath, keyPath: path.join(caDir, "root-ca-key.pem") },
    hostname: "localhost",
  });
  origin = createHttpsServer(leaf, (request, response) => {
    const record = { authorization: request.headers.authorization, body: "" };
    observed.push(record);
    request.on("error", () => {});
    request.on("data", (chunk: Buffer) => {
      record.body += chunk.toString();
    });
    request.once("end", () => {
      response.writeHead(200, { Connection: "close", "Content-Length": 2 });
      response.end("ok");
    });
  });
  origin.on("connection", trackSocket);
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const address = origin.address();
  if (!address || typeof address === "string") {
    throw new Error("Origin did not bind");
  }
  originPort = address.port;
  sentinel = mintSecretSentinel(value, { label: "egress-lifecycle" });
  proxyEnv = register();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await proxy?.stop();
  if (origin) {
    await new Promise<void>((resolve) => {
      origin.close(() => resolve());
    });
  }
  fs.rmSync(caDir, { recursive: true, force: true });
});

describe("secret egress registration lifecycle", () => {
  it("keeps the process CA trusted beyond the first day", () => {
    const cert = new X509Certificate(fs.readFileSync(proxy.caCertPath));
    const afterOneDay = Math.floor(cert.validFromDate.getTime() / 1000) + 25 * 60 * 60;
    expect(() =>
      execFileSync(
        "openssl",
        ["verify", "-CAfile", proxy.caCertPath, "-attime", String(afterOneDay), proxy.caCertPath],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("renews cached leaves without replacing client trust or established connections", async () => {
    const issued: X509Certificate[] = [];
    const issueLeaf = proxyCa.generateLocalProxyLeaf;
    vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockImplementation(async (params) => {
      const leaf = await issueLeaf(params);
      issued.push(new X509Certificate(leaf.cert));
      return leaf;
    });
    const existing = await openTlsTunnel();
    const previous = issued[0]!;
    const trustedCa = fs.readFileSync(proxy.caCertPath);
    // OpenSSL uses the native clock. Advance the cache's clock into the leaf's
    // renewal window while real TLS verifies both certificates and the same CA.
    vi.spyOn(Date, "now").mockReturnValue(previous.validToDate.getTime() - 30 * 60_000);
    const renewed = await Promise.all([openTlsTunnel(), openTlsTunnel()]);
    for (const socket of renewed) {
      await sendCredential(socket);
    }
    expect(fs.readFileSync(proxy.caCertPath)).toEqual(trustedCa);
    await sendCredential(existing);
    expect(observed).toHaveLength(3);
    expect(issued.length).toBe(2);
    expect(issued[1]!.fingerprint256).not.toBe(previous.fingerprint256);
    expect(issued[1]!.checkIssued(new X509Certificate(trustedCa))).toBe(true);
  });
  it.each([false, true])(
    "recovers certificate failures on the next request (renewal: %s)",
    async (renewing) => {
      const existing = renewing ? await openTlsTunnel() : undefined;
      if (renewing) {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 23.5 * 60 * 60_000);
      }
      vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockRejectedValueOnce(
        new Error("synthetic-private-openssl-output"),
      );
      expect((await connectTunnel()).status).toBe(502);
      const failed = proxy.getCertificateStatus();
      expect(failed.state).toBe("degraded");
      expect(failed.failedCertificates).toBe(1);
      expect(failed.message).toContain("retry the request");
      expect(JSON.stringify(failed)).not.toContain("synthetic-private-openssl-output");
      if (existing) {
        await sendCredential(existing);
      }
      await sendCredential(await openTlsTunnel());
      expect(proxy.getCertificateStatus().state).toBe("ready");
      expect(proxy.getCertificateStatus().failedCertificates).toBe(0);
      expect(observed.length).toBe(renewing ? 2 : 1);
    },
  );

  it("reports root expiry without minting leaves or replacing the trust bundle", async () => {
    const trust = fs.readFileSync(proxyEnv.NODE_EXTRA_CA_CERTS!);
    const validity = new X509Certificate(fs.readFileSync(proxy.caCertPath));
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(validity.validToDate.getTime() - 60_000);
    expect(proxy.getCertificateStatus().message).toContain("expires within seven days");
    clock.mockReturnValue(validity.validToDate.getTime());
    const generateLeaf = vi.spyOn(proxyCa, "generateLocalProxyLeaf");
    expect((await connectTunnel()).status).toBe(502);
    expect(proxy.getCertificateStatus().message).toContain("restart the Gateway");
    expect(generateLeaf).not.toHaveBeenCalled();
    expect(fs.readFileSync(proxyEnv.NODE_EXTRA_CA_CERTS!)).toEqual(trust);
    clock.mockRestore();
    await sendCredential(await openTlsTunnel());
    expect(proxy.getCertificateStatus().state).toBe("ready");
  });

  it.each(["revoke", "replace", "stop"] as const)(
    "%s closes established TLS before its first credential request",
    async (action) => {
      const oldConnection = await openTlsTunnel();
      const siblingEnv = register(sibling);
      const siblingConnection = await openTlsTunnel(siblingEnv);
      let stopped: Promise<void> | undefined;
      if (action === "stop") {
        stopped = proxy.stop();
      } else {
        proxy.revokeRun(run);
      }
      if (action === "replace") {
        proxyEnv = register();
      }
      await sendCredential(oldConnection);
      expect(observed).toEqual([]);
      if (stopped) {
        await stopped;
        expect(() => register()).toThrow();
        return;
      }
      await sendCredential(siblingConnection);
      expect(observed).toEqual([{ authorization: `Bearer ${value}`, body: "" }]);
      if (action === "replace") {
        await sendCredential(await openTlsTunnel());
        expect(observed).toHaveLength(2);
      }
    },
  );

  it("does not reuse a revoked registration's cached TLS bindings on a fresh connection", async () => {
    await sendCredential(await openTlsTunnel());
    proxy.revokeRun(run);
    proxyEnv = proxy.registerRun(run, []);
    await sendCredential(await openTlsTunnel());
    expect(observed).toEqual([{ authorization: `Bearer ${value}`, body: "" }]);
  });

  it("revokes streaming substitution and upstream resources between body chunks", async () => {
    const socket = await openTlsTunnel();
    const firstChunk = createDeferredCore<IncomingMessage>();
    origin.once("request", (request) => request.once("data", () => firstChunk.resolve(request)));
    socket.write(
      `POST / HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    const prefix = "safe-prefix".repeat(100);
    const split = Math.floor(sentinel.length / 2);
    const first = prefix + sentinel.slice(0, split);
    socket.write(`${Buffer.byteLength(first).toString(16)}\r\n${first}\r\n`);
    const upstreamRequest = await firstChunk.promise;
    const upstreamClosed = onClose(upstreamRequest);
    const clientClosed = onClose(socket);
    proxy.revokeRun(run);
    const last = sentinel.slice(split);
    socket.write(`${Buffer.byteLength(last).toString(16)}\r\n${last}\r\n0\r\n\r\n`);
    await Promise.all([upstreamClosed, clientClosed]);
    expect(observed).toEqual([{ authorization: undefined, body: prefix }]);
    await sendCredential(await openTlsTunnel(register(sibling)));
    expect(observed.at(-1)?.authorization).toBe(`Bearer ${value}`);
  });

  it.each([
    { action: "revoke", renewing: false },
    { action: "stop", renewing: false },
    { action: "replace", renewing: false },
    { action: "revoke", renewing: true },
    { action: "stop", renewing: true },
    { action: "replace", renewing: true },
  ] as const)(
    "$action fences CONNECT while certificate work is pending (renewal: $renewing)",
    async ({ action, renewing }) => {
      if (renewing) {
        await sendCredential(await openTlsTunnel());
        observed = [];
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 23.5 * 60 * 60_000);
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const settled = createDeferredCore();
      let leafPrepared = false;
      const generateLeaf = proxyCa.generateLocalProxyLeaf;
      vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockImplementationOnce(async (params) => {
        entered.resolve();
        try {
          await release.promise;
          const leaf = await generateLeaf(params);
          leafPrepared = true;
          return leaf;
        } finally {
          settled.resolve();
        }
      });
      const connecting = connectTunnel();
      try {
        await entered.promise;
        const stopping = action === "stop" ? proxy.stop() : undefined;
        if (action !== "stop") {
          proxy.revokeRun(run);
          if (action === "replace") {
            proxyEnv = register();
          }
        }
        release.resolve();
        expect((await connecting).status).not.toBe(200);
        await stopping;
        if (stopping) {
          expect(leafPrepared).toBe(true);
        }
        expect(observed).toEqual([]);
        if (action !== "stop") {
          await sendCredential(await openTlsTunnel(register()));
          expect(observed.at(-1)?.authorization).toBe(`Bearer ${value}`);
        }
      } finally {
        release.resolve();
        await connecting;
        await settled.promise;
      }
    },
  );

  it("releases both ends of a bypass CONNECT on revocation", async () => {
    await proxy.stop();
    proxy = await startSecretEgressProxyServer({
      caDir,
      bypassHosts: ["localhost"],
      onAudit: () => {},
    });
    proxyEnv = register();
    const connected = once(origin, "secureConnection");
    const socket = await openTlsTunnel();
    const [upstreamSocket] = await connected;
    const upstreamClosed = onClose(upstreamSocket);
    proxy.revokeRun(run);
    await sendCredential(socket);
    await upstreamClosed;
    expect(observed).toEqual([]);
    await sendCredential(await openTlsTunnel(register(sibling)));
    expect(observed.at(-1)?.authorization).toBe(`Bearer ${sentinel}`);
  });
});
