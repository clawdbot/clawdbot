import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { openProviderWebSocket } from "./provider-websocket.js";

const cleanups: Array<() => Promise<void>> = [];

async function createLocalWebSocketServer(options: { tls?: boolean } = {}) {
  const server = options.tls
    ? createHttpsServer({ cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM })
    : createHttpServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];
  server.on("upgrade", (request, socket, head) => {
    requestHeaders.push(request.headers);
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit("connection", client, request);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  cleanups.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        for (const client of websocketServer.clients) {
          client.terminate();
        }
        websocketServer.close(() => server.close((error) => (error ? reject(error) : resolve())));
      }),
  );
  return {
    requestHeaders,
    url: `${options.tls ? "wss" : "ws"}://127.0.0.1:${port}/listen`,
  };
}

async function createConnectProxy(proxyHostname = "127.0.0.1") {
  const server = createHttpServer();
  let connectCount = 0;
  server.on("connect", (request, clientSocket, head) => {
    connectCount += 1;
    const [hostname, rawPort] = (request.url ?? "").split(":");
    const targetSocket = net.connect(Number(rawPort), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) {
        targetSocket.write(head);
      }
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  cleanups.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { connectCount: () => connectCount, url: `http://${proxyHostname}:${port}` };
}

describe("openProviderWebSocket", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each([
    { name: "private", allowPrivateNetwork: false },
    { name: "pre-aborted", allowPrivateNetwork: true, signal: AbortSignal.abort() },
  ])("does not open a $name socket", async (testCase) => {
    const server = await createLocalWebSocketServer();
    await expect(
      openProviderWebSocket({
        allowPrivateNetwork: testCase.allowPrivateNetwork,
        baseUrl: server.url,
        headers: { authorization: "Token test" },
        ...(testCase.signal ? { signal: testCase.signal } : {}),
        timeoutMs: 1000,
        trustConfiguredBaseUrlOrigin: false,
        url: server.url,
      }),
    ).rejects.toThrow(/private|loopback|blocked|aborted/iu);
    expect(server.requestHeaders).toHaveLength(0);
  });

  it("opens an allowed socket with resolved request headers", async () => {
    const server = await createLocalWebSocketServer();
    const socket = await openProviderWebSocket({
      allowPrivateNetwork: true,
      baseUrl: server.url,
      headers: { authorization: "Token configured", "x-provider": "deepgram" },
      timeoutMs: 1000,
      trustConfiguredBaseUrlOrigin: false,
      url: server.url,
    });
    await once(socket, "open");
    expect(server.requestHeaders[0]?.authorization).toBe("Token configured");
    expect(server.requestHeaders[0]?.["x-provider"]).toBe("deepgram");
    socket.close();
    await once(socket, "close");
  });

  it("applies target TLS settings to the WebSocket handshake", async () => {
    const server = await createLocalWebSocketServer({ tls: true });
    const socket = await openProviderWebSocket({
      allowPrivateNetwork: true,
      baseUrl: server.url,
      dispatcherPolicy: { mode: "direct", connect: { rejectUnauthorized: false } },
      timeoutMs: 1000,
      trustConfiguredBaseUrlOrigin: false,
      url: server.url,
    });
    await once(socket, "open");
    expect(server.requestHeaders).toHaveLength(1);
    socket.close();
    await once(socket, "close");
  });

  it("routes the WebSocket handshake through an explicit proxy", async () => {
    const target = await createLocalWebSocketServer();
    const connectSpy = vi.spyOn(net, "connect");
    const proxy = await createConnectProxy("localhost");
    const socket = await openProviderWebSocket({
      allowPrivateNetwork: true,
      baseUrl: target.url,
      dispatcherPolicy: { mode: "explicit-proxy", proxyUrl: proxy.url },
      timeoutMs: 1000,
      trustConfiguredBaseUrlOrigin: false,
      url: target.url,
    });
    await once(socket, "open");
    expect(proxy.connectCount()).toBe(1);
    expect(target.requestHeaders).toHaveLength(1);
    expect(
      connectSpy.mock.calls.some(
        ([options]) => typeof asOptionalRecord(options)?.lookup === "function",
      ),
    ).toBe(true);
    socket.close();
    await once(socket, "close");
  });
});
