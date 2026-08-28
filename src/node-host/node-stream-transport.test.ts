import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { installGlobalProxy } from "@openclaw/proxyline";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { runNodeStreamTransport } from "./node-stream-transport.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;

describe.each([false, true])("node stream TLS (managed proxy: %s)", (managed) => {
  it.each([
    { streamName: "desktop", correctPin: true, tls: true },
    { streamName: "portal", correctPin: true, tls: true },
    { streamName: "desktop", correctPin: false, tls: true },
    { streamName: "portal", correctPin: false, tls: true },
    { streamName: "desktop", correctPin: false, tls: false },
    { streamName: "portal", correctPin: false, tls: false },
  ])(
    "validates $streamName before attaching (correct pin: $correctPin, TLS: $tls)",
    async ({ streamName, correctPin, tls }) => {
      const sockets = new Set<net.Socket>();
      const servers: net.Server[] = [];
      const track = (socket: net.Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      };
      const listen = async (server: net.Server) => {
        servers.push(server);
        server.on("connection", track);
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        return (server.address() as AddressInfo).port;
      };
      const localPort = await listen(
        net.createServer((socket) => {
          socket.on("data", (chunk) => socket.write(chunk));
        }),
      );
      const gateway = tls
        ? createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM })
        : createHttpServer();
      let bytes = 0;
      gateway.on(tls ? "secureConnection" : "connection", (socket: net.Socket) => {
        socket.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
      });
      const wss = new WebSocketServer({ server: gateway });
      const frames: string[] = [];
      const accessHeaders: unknown[] = [];
      wss.on("connection", (ws, request) => {
        accessHeaders.push(request.headers["cf-access-client-secret"]);
        ws.on("message", (data) => {
          frames.push(rawDataToString(data));
          if (frames.length === 1) {
            ws.send(Buffer.from("stream-echo"));
          }
        });
      });
      const gatewayPort = await listen(gateway);
      const proxyServer = createHttpServer();
      let tunnels = 0;
      proxyServer.on("connect", (_request, downstream, head) => {
        tunnels++;
        const upstream = net.connect(gatewayPort, "127.0.0.1", () => {
          downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          downstream.pipe(upstream).pipe(downstream);
        });
        track(upstream);
        downstream.on("error", () => upstream.destroy());
        upstream.on("error", () => downstream.destroy());
        downstream.once("close", () => upstream.destroy());
        upstream.once("close", () => downstream.destroy());
      });
      const proxyPort = managed ? await listen(proxyServer) : undefined;
      const proxy = managed
        ? installGlobalProxy({ mode: "managed", proxyUrl: `http://127.0.0.1:${proxyPort}` })
        : undefined;
      const controller = new AbortController();
      let failure: unknown;
      const running = runNodeStreamTransport({
        gatewayUrl: `${tls ? "wss" : "ws"}://127.0.0.1:${gatewayPort}`,
        gatewayTlsFingerprint: correctPin ? fingerprint : "ab".repeat(32),
        gatewayCloudflareAccess: {
          clientId: "fixture-client-id",
          clientSecret: "fixture-client-secret",
        },
        attachPath: `/node-${streamName}/attach?ticket=fixture`,
        expectedAttachPath: `/node-${streamName}/attach`,
        port: localPort,
        metadata: { ok: true },
        streamName,
        signal: controller.signal,
        connectAfterGatewayAttach: streamName === "portal",
      }).catch((error: unknown) => {
        failure = error;
      });
      try {
        if (correctPin) {
          await expect.poll(() => frames).toEqual([JSON.stringify({ ok: true }), "stream-echo"]);
          expect(failure).toBeUndefined();
          expect(accessHeaders).toEqual(["fixture-client-secret"]);
        } else {
          await expect.poll(() => failure).toBeInstanceOf(Error);
          expect(String(failure)).toMatch(/fingerprint (?:mismatch|unavailable)/i);
        }
        controller.abort();
        await running;
        await expect.poll(() => sockets.size).toBe(0);
        if (!correctPin) {
          expect(bytes).toBe(0);
          expect(frames).toEqual([]);
          expect(accessHeaders).toEqual([]);
        }
        expect(tunnels).toBe(managed ? 1 : 0);
      } finally {
        controller.abort();
        await running;
        proxy?.stop();
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        for (const server of servers.toReversed()) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }
      }
    },
  );
});
