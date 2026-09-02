import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { installGlobalProxy, type ProxylineHandle } from "@openclaw/proxyline";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { GatewayClient, type GatewayClientCloseInfo } from "./client.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const servers: Server[] = [];
const sockets = new Set<Socket>();
let socketDrain = createDeferred();
const clients: GatewayClient[] = [];
let proxy: ProxylineHandle | undefined;

function trackSocket(socket: Socket) {
  if (sockets.size === 0) {
    socketDrain = createDeferred();
  }
  sockets.add(socket);
  socket.once("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0) {
      socketDrain.resolve();
    }
  });
}

async function waitForSocketDrain() {
  // Recheck after waking: a new accepted socket can start another drain generation.
  while (sockets.size > 0) {
    await socketDrain.promise;
  }
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", trackSocket);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.stopAndWait();
  }
  proxy?.stop();
  proxy = undefined;
  for (const socket of sockets) {
    socket.destroy();
  }
  for (const server of servers.splice(0).toReversed()) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  await waitForSocketDrain();
});

async function startProxy(targetPort: number) {
  const server = createHttpServer();
  let tunnels = 0;
  server.on("connect", (_request, downstream, head) => {
    tunnels++;
    const upstream = connect(targetPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    trackSocket(upstream);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
  });
  const port = await listen(server);
  proxy = installGlobalProxy({ mode: "managed", proxyUrl: `http://127.0.0.1:${port}` });
  return () => tunnels;
}

describe.each([false, true])("Gateway TLS upgrade (managed proxy: %s)", (managed) => {
  it.each([
    { name: "wrong pin", pin: "ab".repeat(32), expectHeader: false, urlAuth: false },
    { name: "wrong pin with Expect", pin: "ab".repeat(32), expectHeader: true, urlAuth: false },
    { name: "wrong pin with URL auth", pin: "ab".repeat(32), expectHeader: false, urlAuth: true },
    {
      name: "wrong pin with Expect and URL auth",
      pin: "ab".repeat(32),
      expectHeader: true,
      urlAuth: true,
    },
    { name: "correct pin", pin: fingerprint, expectHeader: true, urlAuth: true },
    { name: "CA validation without a pin", pin: undefined, expectHeader: true, urlAuth: true },
  ])("validates $name before upgrade", async ({ pin, expectHeader, urlAuth }) => {
    const server = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
    let httpBytes = 0;
    let upgrades = 0;
    let headers: IncomingHttpHeaders | undefined;
    server.on("secureConnection", (socket) => {
      socket.on("data", (chunk: Buffer) => {
        httpBytes += chunk.length;
      });
    });
    const wss = new WebSocketServer({ server });
    const outcome = createDeferred<Error | "open">();
    const closed = createDeferred<GatewayClientCloseInfo | undefined>();
    wss.on("connection", (_socket, request) => {
      upgrades++;
      headers = request.headers;
      if (pin === fingerprint) {
        outcome.resolve("open");
      }
    });
    const port = await listen(server);
    const tunnels = managed ? await startProxy(port) : undefined;
    const client = new GatewayClient({
      url: `wss://${urlAuth ? "fixture:synthetic-password@" : ""}127.0.0.1:${port}`,
      tlsFingerprint: pin,
      deviceIdentity: null,
      edgeAuthHeaders: {
        "X-Test-Edge-Auth": "synthetic-test-edge-token",
        ...(expectHeader ? { eXpEcT: "100-continue" } : {}),
      },
      onConnectError: outcome.resolve,
      onClose: (_code, _reason, info) => closed.resolve(info),
    });
    clients.push(client);
    client.start();
    const result = await outcome.promise;
    await client.stopAndWait();
    await waitForSocketDrain();
    if (pin === fingerprint) {
      expect(result).toBe("open");
      expect(httpBytes).toBeGreaterThan(0);
      expect(upgrades).toBe(1);
      expect(headers).toMatchObject({
        "x-test-edge-auth": "synthetic-test-edge-token",
        expect: "100-continue",
        authorization: `Basic ${Buffer.from("fixture:synthetic-password").toString("base64")}`,
      });
    } else {
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toMatch(pin ? /tls fingerprint mismatch/i : /certificate/i);
      expect(httpBytes).toBe(0);
      expect(upgrades).toBe(0);
      expect(await closed.promise).toMatchObject({
        phase: "pre-hello",
        socketOpened: false,
        transportValidated: false,
        connectRequestSent: false,
      });
    }
    expect(tunnels?.() ?? 0).toBe(managed ? 1 : 0);
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  });

  it.each(["timeout", "cancel"])("cleans up a stalled TLS handshake on %s", async (action) => {
    const accepted = createDeferred();
    const server = createTcpServer((socket) => {
      socket.on("data", () => accepted.resolve());
    });
    const port = await listen(server);
    const tunnels = managed ? await startProxy(port) : undefined;
    const failed = createDeferred<Error>();
    const client = new GatewayClient({
      url: `wss://127.0.0.1:${port}`,
      tlsFingerprint: fingerprint,
      deviceIdentity: null,
      preauthHandshakeTimeoutMs: 100,
      onConnectError: failed.resolve,
    });
    clients.push(client);
    client.start();
    await accepted.promise;
    if (action === "timeout") {
      expect(String(await failed.promise)).toMatch(/timed out/i);
    }
    await client.stopAndWait();
    await waitForSocketDrain();
    expect(tunnels?.() ?? 0).toBe(managed ? 1 : 0);
  });
});
