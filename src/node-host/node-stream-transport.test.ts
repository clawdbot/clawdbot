import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { installGlobalProxy } from "@openclaw/proxyline";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { runNodeStreamTransport } from "./node-stream-transport.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const ticket = "1".repeat(48);
const logPaths = createSuiteLogPathTracker("node-stream-diagnostics-");
const logCaptures: ReturnType<typeof createDiagnosticLogRecordCapture>[] = [];

beforeAll(async () => logPaths.setup());
beforeEach(() =>
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logPaths.nextPath() }),
);
afterEach(async () => {
  try {
    await flushLogger();
    for (const capture of logCaptures) {
      await capture.flush();
    }
  } finally {
    for (const capture of logCaptures.splice(0)) {
      capture.cleanup();
    }
    resetLogger();
  }
});
afterAll(async () => logPaths.cleanup());

describe.each([false, true])("node stream TLS (managed proxy: %s)", (managed) => {
  it.each([
    ...["desktop", "portal"].flatMap((streamName) =>
      (["target-eof", "gateway-close", "gateway-terminate", "owner-abort"] as const).map(
        (closeMode) => ({ streamName, closeMode, correctPin: true, tls: true }),
      ),
    ),
    { streamName: "desktop", correctPin: false, tls: true, closeMode: "target-eof" },
    { streamName: "portal", correctPin: false, tls: true, closeMode: "target-eof" },
    { streamName: "desktop", correctPin: false, tls: false, closeMode: "target-eof" },
    { streamName: "portal", correctPin: false, tls: false, closeMode: "target-eof" },
  ])(
    "validates $streamName and records $closeMode (correct pin: $correctPin, TLS: $tls)",
    async ({ streamName, correctPin, tls, closeMode }) => {
      const logCapture = createDiagnosticLogRecordCapture();
      logCaptures.push(logCapture);
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
          socket.on("data", (chunk) => {
            if (closeMode === "target-eof") {
              socket.end(chunk);
            } else {
              socket.write(chunk);
            }
          });
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
        attachPath: `/node-${streamName}/attach?ticket=${ticket}`,
        expectedAttachPath: `/node-${streamName}/attach`,
        target:
          streamName === "portal"
            ? { port: localPort }
            : {
                stream: await new Promise<net.Socket>((resolve, reject) => {
                  const socket = net.connect(localPort, "127.0.0.1", () => resolve(socket));
                  socket.once("error", reject);
                }),
              },
        metadata: { ok: true },
        streamName,
        signal: controller.signal,
      }).catch((error: unknown) => {
        failure = error;
      });
      try {
        if (correctPin) {
          if (closeMode === "target-eof") {
            await running;
          } else {
            await expect.poll(() => frames).toEqual([JSON.stringify({ ok: true }), "stream-echo"]);
          }
          expect(failure).toBeUndefined();
          expect(accessHeaders).toEqual(["fixture-client-secret"]);
          if (closeMode === "owner-abort") {
            controller.abort();
          } else if (closeMode !== "target-eof") {
            for (const peer of wss.clients) {
              if (closeMode === "gateway-close") {
                peer.close(1012, `peer restart\n${ticket} fixture-client-secret`);
              } else {
                peer.terminate();
              }
            }
          }
          await running;
          expect(frames).toEqual([JSON.stringify({ ok: true }), "stream-echo"]);
          await expect
            .poll(async () => {
              await logCapture.flush();
              return logCapture.records.filter((record) => record.message === "node stream closed");
            })
            .toHaveLength(1);
          const trigger =
            closeMode === "owner-abort"
              ? "owner-abort"
              : closeMode === "target-eof"
                ? "target-close"
                : "websocket-close";
          const closeCode =
            closeMode === "gateway-close" ? 1012 : closeMode === "target-eof" ? 1005 : 1006;
          const terminalRecord = logCapture.records.find(
            (record) => record.message === "node stream closed",
          );
          expect(terminalRecord?.attributes).toMatchObject({
            streamKind: streamName,
            trigger,
            closeCode,
          });
          expect(terminalRecord?.attributes?.closeReason).toBeUndefined();
          expect(failure).toBeUndefined();
          const serialized = JSON.stringify(logCapture.records);
          expect(serialized).not.toContain(ticket);
          expect(serialized).not.toContain("peer restart");
          expect(serialized).not.toContain("fixture-client-secret");
          expect(serialized).not.toContain("stream-echo");
          expect(serialized).not.toContain("attach?ticket=");
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

describe("node stream startup ownership", () => {
  it.each([
    ["malformed URL", { gatewayUrl: "not-a-url" }],
    ["cross-origin attachment", { attachPath: "ws://example.invalid/node-desktop/attach" }],
    ["constructor rejects fragment", { attachPath: "/node-desktop/attach#invalid" }],
    [
      "constructor rejects header",
      { gatewayCloudflareAccess: { clientId: "invalid\nheader", clientSecret: "fixture" } },
    ],
  ])("closes its connected target when %s fails", async (_name, override) => {
    const peerClosed = createDeferred();
    const local = net.createServer((peer) => peer.once("close", () => peerClosed.resolve()));
    await new Promise<void>((resolve) => {
      local.listen(0, "127.0.0.1", resolve);
    });
    const port = (local.address() as AddressInfo).port;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const connected = net.connect(port, "127.0.0.1", () => resolve(connected));
      connected.once("error", reject);
    });
    try {
      await expect(
        runNodeStreamTransport({
          gatewayUrl: "ws://127.0.0.1:1",
          attachPath: "/node-desktop/attach",
          expectedAttachPath: "/node-desktop/attach",
          target: { stream: socket },
          metadata: { auth: "vnc-password" },
          streamName: "desktop",
          signal: new AbortController().signal,
          ...override,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(socket.destroyed).toBe(true);
      await peerClosed.promise;
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => {
        local.close(() => resolve());
      });
    }
  });
});

describe("node stream EOF with inbound backpressure", () => {
  it.each(["desktop", "portal"])(
    "settles %s after the target closes before drain",
    async (streamName) => {
      const wrote = createDeferred();
      let writes = 0;
      const target = new Duplex({
        highWaterMark: 1,
        read() {},
        write(_chunk, _encoding, _callback) {
          // The target closes with a write pending, so it will never emit drain.
          writes++;
          wrote.resolve();
        },
      });
      target.once("end", () => target.destroy());
      const gateway = createHttpServer();
      const wss = new WebSocketServer({ server: gateway });
      const frames: string[] = [];
      wss.on("connection", (ws) => {
        ws.on("message", (data) => {
          frames.push(rawDataToString(data));
          if (frames.length === 1) {
            ws.send(Buffer.from("pending-target-write"));
          } else {
            ws.send(Buffer.from("late-target-write"));
          }
        });
      });
      await new Promise<void>((resolve) => {
        gateway.listen(0, "127.0.0.1", resolve);
      });
      const controller = new AbortController();
      let settled = false;
      const running = runNodeStreamTransport({
        gatewayUrl: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
        attachPath: `/node-${streamName}/attach`,
        expectedAttachPath: `/node-${streamName}/attach`,
        target: { stream: target },
        metadata: { ok: true },
        streamName,
        signal: controller.signal,
      }).then(() => {
        settled = true;
      });
      try {
        await wrote.promise;
        target.push(Buffer.from("terminal-response"));
        target.push(null);
        await expect.poll(() => settled).toBe(true);
        await running;
        expect(frames).toEqual([JSON.stringify({ ok: true }), "terminal-response"]);
        expect(writes).toBe(1);
        expect(target.listenerCount("drain")).toBe(0);
      } finally {
        controller.abort();
        await running;
        for (const client of wss.clients) {
          client.terminate();
        }
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
          gateway.close(() => resolve());
        });
      }
    },
  );
});
