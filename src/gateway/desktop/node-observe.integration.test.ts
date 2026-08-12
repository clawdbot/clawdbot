import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { invokeNodeDesktopStream } from "../../node-host/desktop-stream-command.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import type { NodeRegistry } from "../node-registry.js";
import { createNodeDesktopService } from "./node-source.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import { handleDesktopObserveUpgrade } from "./observe-bridge.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");
const cleanups: Array<() => Promise<void>> = [];

function handleExpectedPeerTeardownError(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class SocketReader {
  private buffered = Buffer.alloc(0);
  private readonly waiters = new Set<() => void>();

  constructor(socket: net.Socket) {
    socket.on("data", (chunk) => {
      this.buffered = Buffer.concat([
        this.buffered,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      for (const waiter of this.waiters) {
        waiter();
      }
      this.waiters.clear();
    });
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }
}

class WebSocketReader {
  private readonly chunks: Buffer[] = [];
  private readonly waiters: Array<(chunk: Buffer) => void> = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data: RawData) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(chunk);
      } else {
        this.chunks.push(chunk);
      }
    });
  }

  async next(): Promise<Buffer> {
    return (
      this.chunks.shift() ??
      (await new Promise<Buffer>((resolve) => {
        this.waiters.push(resolve);
      }))
    );
  }
}

describe("paired node desktop observe integration", () => {
  it("relays pixels through the node attach socket and drops view-only input", async () => {
    const rfbPeers = new Set<net.Socket>();
    let connectionCount = 0;
    let completedStreams = 0;
    let resolveRfbScript!: () => void;
    let rejectRfbScript!: (error: Error) => void;
    const rfbScript = new Promise<void>((resolve, reject) => {
      resolveRfbScript = resolve;
      rejectRfbScript = reject;
    });
    const rfbServer = net.createServer((socket) => {
      rfbPeers.add(socket);
      socket.once("close", () => rfbPeers.delete(socket));
      // Session teardown destroys client sockets; the synthetic server owns the matching resets.
      socket.on("error", handleExpectedPeerTeardownError);
      connectionCount += 1;
      const connectionIndex = connectionCount;
      const reader = new SocketReader(socket);
      void (async () => {
        try {
          socket.write(VERSION);
          expect(await reader.readExactly(VERSION.length)).toEqual(VERSION);
          socket.write(Buffer.from([1, 2]));
          if (connectionIndex % 2 === 1) {
            return;
          }
          expect(await reader.readExactly(1)).toEqual(Buffer.from([2]));
          socket.write(Buffer.alloc(16, 7));
          expect(await reader.readExactly(16)).toHaveLength(16);
          socket.write(Buffer.alloc(4));

          expect(await reader.readExactly(1)).toEqual(Buffer.from([1]));
          socket.write(Buffer.from("pixel-update", "ascii"));
          const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
          expect(await reader.readExactly(framebufferRequest.length)).toEqual(framebufferRequest);
          completedStreams += 1;
          if (completedStreams === 2) {
            resolveRfbScript();
          }
        } catch (error) {
          rejectRfbScript(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    await new Promise<void>((resolve) => {
      rfbServer.listen(0, "127.0.0.1", resolve);
    });
    const rfbAddress = rfbServer.address();
    if (!rfbAddress || typeof rfbAddress === "string") {
      throw new Error("expected RFB address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const peer of rfbPeers) {
            peer.destroy();
          }
          rfbServer.close(() => resolve());
        }),
    );

    const desktopRegistry = createDesktopSessionRegistry({ lingerMs: 10 });
    const streamBroker = createNodeDesktopStreamBroker();
    cleanups.push(async () => desktopRegistry.stopAll());
    const httpServer = http.createServer();
    let gatewayUrl = "";
    const nodeSession = {
      nodeId: "node-1",
      connId: "conn-1",
      pairingGeneration: "generation-1",
      platform: "linux",
      deviceFamily: "Linux",
      commands: [NODE_DESKTOP_STREAM_COMMAND],
    };
    const nodeRegistry = {
      get: () => nodeSession,
      getForPairingGeneration: (_nodeId: string, generation: string) =>
        generation === nodeSession.pairingGeneration ? nodeSession : undefined,
      isConnectionCurrentPairingState: async (connId: string) => connId === nodeSession.connId,
      invoke: async (request: {
        params?: unknown;
        signal?: AbortSignal;
        onProgress?: (chunk: string) => void;
      }) => {
        try {
          await invokeNodeDesktopStream({
            paramsJSON: JSON.stringify({
              ...(request.params as { ticket: string; attachPath: string }),
            }),
            gatewayUrl,
            config: { enabled: true, port: rfbAddress.port },
            signal: request.signal ?? new AbortController().signal,
            emitStatus: async (status) => request.onProgress?.(status),
          });
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          };
        }
      },
    } as unknown as NodeRegistry;
    httpServer.on("upgrade", (req, socket, head) => {
      void (async () => {
        if (await streamBroker.handleUpgrade(req, socket, head, nodeRegistry)) {
          return;
        }
        handleDesktopObserveUpgrade(req, socket, head, { registry: desktopRegistry });
      })();
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const httpAddress = httpServer.address();
    if (!httpAddress || typeof httpAddress === "string") {
      throw new Error("expected Gateway address");
    }
    gatewayUrl = `ws://127.0.0.1:${httpAddress.port}`;
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        }),
    );

    const service = createNodeDesktopService({
      getConfig: () => ({
        gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } },
      }),
      nodeRegistry,
      desktopRegistry,
      streamBroker,
    });
    const observed = await service.observe({
      nodeId: nodeSession.nodeId,
      control: false,
      credentials: { password: "memory-only-password" },
    });
    expect(observed.auth).toBe("vnc-password");

    const ws = new WebSocket(`${gatewayUrl}${observed.wsPath}`);
    const browser = new WebSocketReader(ws);
    cleanups.push(async () => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    expect(await browser.next()).toEqual(VERSION);
    ws.send(Buffer.concat([VERSION, Buffer.from([1, 0])]));
    expect(await browser.next()).toEqual(Buffer.from([1, 1]));
    expect(await browser.next()).toEqual(Buffer.alloc(4));
    expect(await browser.next()).toEqual(Buffer.from("pixel-update", "ascii"));

    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    ws.send(Buffer.concat([keyEvent, framebufferRequest]));

    const secondObserved = await service.observe({
      nodeId: nodeSession.nodeId,
      control: false,
      credentials: { password: "memory-only-password" },
    });
    const secondWs = new WebSocket(`${gatewayUrl}${secondObserved.wsPath}`);
    const secondBrowser = new WebSocketReader(secondWs);
    cleanups.push(async () => secondWs.terminate());
    await new Promise<void>((resolve, reject) => {
      secondWs.once("open", resolve);
      secondWs.once("error", reject);
    });
    expect(await secondBrowser.next()).toEqual(VERSION);
    secondWs.send(Buffer.concat([VERSION, Buffer.from([1, 0])]));
    expect(await secondBrowser.next()).toEqual(Buffer.from([1, 1]));
    expect(await secondBrowser.next()).toEqual(Buffer.alloc(4));
    expect(await secondBrowser.next()).toEqual(Buffer.from("pixel-update", "ascii"));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    secondWs.send(Buffer.concat([keyEvent, framebufferRequest]));

    await expect(rfbScript).resolves.toBeUndefined();
    await vi.waitFor(() => expect(connectionCount).toBe(4));
    const firstClosed = new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });
    const secondClosed = new Promise<void>((resolve) => {
      secondWs.once("close", () => resolve());
    });

    await service.stopNode(nodeSession.nodeId);

    await Promise.all([firstClosed, secondClosed]);
    await vi.waitFor(() => expect(rfbPeers.size).toBe(0));
  });
});
