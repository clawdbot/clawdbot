import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createHostDesktopService } from "./host-source.js";
import { handleDesktopObserveUpgrade } from "./observe-bridge.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function readSocketBytes(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= length) {
        socket.off("data", onData);
        resolve(buffered);
      }
    };
    socket.on("data", onData);
  });
}

describe("gateway host desktop observe integration", () => {
  it("upgrades a host token, proxies bytes, and filters view-only input", async () => {
    const peers: net.Socket[] = [];
    const rfbServer = net.createServer((socket) => {
      peers.push(socket);
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      if (peers.length === 1) {
        socket.once("data", () => socket.write(Buffer.from([1, 2])));
      }
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
    const observed = await service.observe(false);
    expect(observed.auth).toBe("vnc-password");
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
    cleanups.push(async () => ws.terminate());
    const banner = new Promise<Buffer>((resolve, reject) => {
      ws.once("message", (data) => resolve(Buffer.from(data as Buffer)));
      ws.once("error", reject);
    });
    await expect(banner).resolves.toEqual(Buffer.from("RFB 003.008\n", "ascii"));
    await vi.waitFor(() => expect(peers).toHaveLength(2));
    const observerPeer = peers[1];
    if (!observerPeer) {
      throw new Error("expected observer RFB peer");
    }

    const handshake = Buffer.concat([Buffer.from("RFB 003.008\n", "ascii"), Buffer.from([1, 1])]);
    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const forwarded = readSocketBytes(observerPeer, handshake.length + framebufferRequest.length);
    ws.send(Buffer.concat([handshake, keyEvent, framebufferRequest]));
    await expect(forwarded).resolves.toEqual(Buffer.concat([handshake, framebufferRequest]));
  });
});
