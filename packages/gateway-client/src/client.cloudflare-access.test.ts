import { X509Certificate } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { GatewayClient } from "./client.js";
import { WebSocketServer } from "./websocket.test-support.js";

const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const websocketServers: WebSocketServer[] = [];
const httpsServers: Array<ReturnType<typeof createHttpsServer>> = [];

async function listen(server: ReturnType<typeof createHttpsServer>): Promise<number> {
  httpsServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const server of websocketServers.splice(0).toReversed()) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  for (const server of httpsServers.splice(0).toReversed()) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

test("sends resolved edge auth headers through the WebSocket upgrade", async () => {
  const edgeAuthValue = "test-secret";
  const httpsServer = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  const websocketServer = new WebSocketServer({
    server: httpsServer,
    verifyClient: ({ req }, done) => {
      const accepted = req.headers["x-edge-auth"] === edgeAuthValue;
      done(accepted, accepted ? undefined : 403, accepted ? undefined : "Access denied");
    },
  });
  websocketServers.push(websocketServer);
  const port = await listen(httpsServer);
  const received = new Promise<Record<string, string | string[] | undefined>>((resolve) => {
    websocketServer.once("connection", (_socket, request) => resolve(request.headers));
  });
  const client = new GatewayClient({
    url: `wss://127.0.0.1:${port}`,
    connectChallengeTimeoutMs: 0,
    edgeAuthHeaders: { "X-Edge-Auth": edgeAuthValue },
    tlsFingerprint,
  });
  client.start();

  await expect(received).resolves.toMatchObject({ "x-edge-auth": edgeAuthValue });
  await client.stopAndWait();
});

test("rejects non-empty edge auth headers before a plaintext WebSocket dial", async () => {
  let resolveConnectError: (error: Error) => void = () => {};
  const connectError = new Promise<Error>((resolve) => {
    resolveConnectError = resolve;
  });
  const client = new GatewayClient({
    url: "ws://127.0.0.1:18789",
    edgeAuthHeaders: { "X-Edge-Auth": "test-secret" },
    onConnectError: resolveConnectError,
  });
  client.start();

  await expect(connectError).resolves.toMatchObject({
    message: "edge auth headers require a wss:// Gateway URL",
  });
  client.stop();
});

test("does not follow an edge redirect and redacts its Location URL", async () => {
  let redirected = false;
  const targetHttpsServer = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  const targetWebSocketServer = new WebSocketServer({ server: targetHttpsServer });
  websocketServers.push(targetWebSocketServer);
  targetWebSocketServer.on("connection", (socket) => {
    redirected = true;
    socket.close();
  });
  const targetPort = await listen(targetHttpsServer);

  const edgeHttpsServer = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  edgeHttpsServer.on("upgrade", (_request, socket) => {
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: wss://127.0.0.1:${targetPort}/?access_token=test-token&safe=1\r\nConnection: close\r\n\r\n`,
    );
  });
  const edgePort = await listen(edgeHttpsServer);
  let resolveConnectError: (error: Error) => void = () => {};
  const connectError = new Promise<Error>((resolve) => {
    resolveConnectError = resolve;
  });
  const client = new GatewayClient({
    url: `wss://127.0.0.1:${edgePort}`,
    edgeAuthHeaders: { "X-Edge-Auth": "test-secret" },
    tlsFingerprint,
    onConnectError: resolveConnectError,
  });
  client.start();

  await expect(connectError).resolves.toMatchObject({
    details: {
      reason: "websocket-upgrade-rejected",
      httpStatus: 302,
      location: `wss://127.0.0.1:${targetPort}/?access_token=***&safe=1`,
    },
  });
  expect(redirected).toBe(false);
  await client.stopAndWait();
});
