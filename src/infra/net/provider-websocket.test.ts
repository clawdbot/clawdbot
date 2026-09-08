import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { openProviderWebSocket } from "./provider-websocket.js";
import * as ssrf from "./ssrf.js";

const cleanups: Array<() => Promise<void>> = [];

async function createStalledHandshakeServer(event: "upgrade" | "connect") {
  const server = createHttpServer();
  const received = createDeferred<Duplex>();
  const connections = new Set<net.Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on(event, (_request, socket) => {
    // HTTP hands upgraded sockets to us with allowHalfOpen enabled.
    // Complete our half only after the client ends its connection.
    socket.once("end", () => socket.end());
    socket.resume();
    received.resolve(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return { url: `http://127.0.0.1:${port}`, received: received.promise };
}

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
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("keeps DNS preparation and the handshake within one connection deadline", async () => {
    const server = await createStalledHandshakeServer("upgrade");
    const lookupStarted = createDeferred();
    const releaseLookup = createDeferred();
    const resolveHostname = ssrf.resolvePinnedHostnameWithPolicy;
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementationOnce(async (...args) => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return await resolveHostname(...args);
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const url = server.url.replace("http:", "ws:");
    const opening = openProviderWebSocket({
      allowPrivateNetwork: true,
      baseUrl: url,
      dispatcherPolicy: { mode: "direct" },
      timeoutMs: 1000,
      trustConfiguredBaseUrlOrigin: false,
      url,
    });
    await lookupStarted.promise;
    await vi.advanceTimersByTimeAsync(600);
    releaseLookup.resolve();
    const socket = await opening;
    const errors: Error[] = [];
    socket.on("error", (error) => errors.push(error));
    const peer = await server.received;
    const closed = once(peer, "close", { signal: AbortSignal.timeout(2000) }).then(
      () => "closed",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(399);
    expect(socket.readyState).toBe(socket.CONNECTING);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(await closed).toBe("closed");
  });

  it.each(["deadline", "caller cancellation", "socket termination"] as const)(
    "closes a stalled proxy CONNECT on %s",
    async (stop) => {
      const proxy = await createStalledHandshakeServer("connect");
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const socket = await openProviderWebSocket({
        allowPrivateNetwork: true,
        baseUrl: "wss://provider.example/audio",
        dispatcherPolicy: { mode: "explicit-proxy", proxyUrl: proxy.url },
        signal: controller.signal,
        timeoutMs: 1000,
        trustConfiguredBaseUrlOrigin: false,
        url: "wss://provider.example/audio",
      });
      socket.on("error", () => {});
      const peer = await proxy.received;
      const closed = once(peer, "close", { signal: AbortSignal.timeout(2000) }).then(
        () => "closed",
        (error: unknown) => error,
      );
      if (stop === "deadline") {
        await vi.advanceTimersByTimeAsync(1000);
      } else if (stop === "caller cancellation") {
        controller.abort();
      } else {
        socket.terminate();
      }
      expect(socket.readyState).not.toBe(socket.CONNECTING);
      expect(await closed).toBe("closed");
    },
  );

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
