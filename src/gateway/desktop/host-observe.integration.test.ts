import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createHostDesktopService } from "./host-source.js";
import { handleDesktopObserveUpgrade } from "./observe-bridge.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");
const cleanups: Array<() => Promise<void>> = [];

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
    const chunk = this.chunks.shift();
    return (
      chunk ??
      (await new Promise<Buffer>((resolve) => {
        this.waiters.push(resolve);
      }))
    );
  }
}

describe("gateway host desktop observe integration", () => {
  it("pre-authenticates ARD, synthesizes None, and starts view-only filtering at ClientInit", async () => {
    const peers = new Set<net.Socket>();
    let connectionCount = 0;
    let resolveObserverScript!: () => void;
    let rejectObserverScript!: (error: Error) => void;
    const observerScript = new Promise<void>((resolve, reject) => {
      resolveObserverScript = resolve;
      rejectObserverScript = reject;
    });
    const rfbServer = net.createServer((socket) => {
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      connectionCount += 1;
      const connectionIndex = connectionCount;
      const reader = new SocketReader(socket);
      void (async () => {
        try {
          socket.write(Buffer.from("RFB 003.889\n", "ascii"));
          expect(await reader.readExactly(12)).toEqual(VERSION);
          socket.write(Buffer.from([4, 30, 33, 36, 35]));
          if (connectionIndex === 1) {
            return;
          }

          expect(await reader.readExactly(1)).toEqual(Buffer.from([30]));
          const keyLength = 16;
          const header = Buffer.alloc(4);
          header.writeUInt16BE(5, 0);
          header.writeUInt16BE(keyLength, 2);
          const modulus = Buffer.alloc(keyLength);
          modulus.writeUInt16BE(7919, keyLength - 2);
          const serverPublic = Buffer.alloc(keyLength);
          serverPublic.writeUInt16BE(6817, keyLength - 2);
          socket.write(Buffer.concat([header, modulus, serverPublic]));
          expect(await reader.readExactly(128 + keyLength)).toHaveLength(128 + keyLength);
          socket.write(Buffer.alloc(4));

          // Browser version/security bytes were consumed by the Gateway. ClientInit is first.
          expect(await reader.readExactly(1)).toEqual(Buffer.from([1]));
          socket.write(Buffer.from("server-init", "ascii"));
          const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
          expect(await reader.readExactly(framebufferRequest.length)).toEqual(framebufferRequest);
          resolveObserverScript();
        } catch (error) {
          rejectObserverScript(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      rfbServer.once("error", reject);
      rfbServer.listen(0, "127.0.0.1", resolve);
    });
    const rfbAddress = rfbServer.address();
    if (!rfbAddress || typeof rfbAddress === "string") {
      throw new Error("expected RFB address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const peer of peers) {
            peer.destroy();
          }
          rfbServer.close(() => resolve());
        }),
    );

    const registry = createDesktopSessionRegistry({ lingerMs: 10 });
    const service = createHostDesktopService({
      config: { enabled: true, port: rfbAddress.port },
      registry,
    });
    cleanups.push(async () => registry.stopAll());
    const observed = await service.observe({
      control: false,
      credentials: { username: "operator", password: "account-password" },
    });
    expect(observed.auth).toBe("ard-account");
    expect(observed.vncPassword).toBeUndefined();

    const httpServer = http.createServer();
    httpServer.on("upgrade", (req, socket, head) => {
      handleDesktopObserveUpgrade(req, socket, head, { registry });
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const httpAddress = httpServer.address();
    if (!httpAddress || typeof httpAddress === "string") {
      throw new Error("expected HTTP address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        }),
    );

    const ws = new WebSocket(`ws://127.0.0.1:${httpAddress.port}${observed.wsPath}`);
    const browser = new WebSocketReader(ws);
    cleanups.push(async () => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    expect(await browser.next()).toEqual(VERSION);
    // Coalesce the synthetic handshake replies with exclusive ClientInit.
    ws.send(Buffer.concat([VERSION, Buffer.from([1, 0])]));
    expect(await browser.next()).toEqual(Buffer.from([1, 1]));
    expect(await browser.next()).toEqual(Buffer.alloc(4));
    expect(await browser.next()).toEqual(Buffer.from("server-init", "ascii"));

    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    ws.send(Buffer.concat([keyEvent, framebufferRequest]));
    await expect(observerScript).resolves.toBeUndefined();
    await vi.waitFor(() => expect(connectionCount).toBe(2));
  });
});
