import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { invokeNodeDesktopStream } from "./desktop-stream-command.js";

const TICKET = "a".repeat(48);
const cleanups: Array<() => Promise<void>> = [];

function handleExpectedPeerTeardownError(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("node desktop stream command", () => {
  it("refuses a caller-selected RFB target before dialing", async () => {
    await expect(
      invokeNodeDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          target: { host: "192.0.2.10", port: 5900 },
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        config: { enabled: true },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unsupported fields");
  });

  it("refuses an attach path that changes the connected gateway origin", async () => {
    await expect(
      invokeNodeDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `//attacker.example/node-desktop/attach?ticket=${TICKET}`,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        config: { enabled: true },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("ticket and attachPath required");
  });

  it("tears down both splice sockets when the invoke is cancelled", async () => {
    const rfbPeers = new Set<net.Socket>();
    const rfbServer = net.createServer((socket) => {
      rfbPeers.add(socket);
      socket.once("close", () => rfbPeers.delete(socket));
      // Cancellation destroys the client socket; the synthetic server owns the matching reset.
      socket.on("error", handleExpectedPeerTeardownError);
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => socket.write(Buffer.from([1, 2])));
    });
    await new Promise<void>((resolve) => {
      rfbServer.listen(0, "127.0.0.1", resolve);
    });
    const rfbAddress = rfbServer.address();
    if (!rfbAddress || typeof rfbAddress === "string") {
      throw new Error("expected RFB test address");
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

    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    let streamClosed = false;
    wss.on("connection", (ws) => {
      ws.once("close", () => {
        streamClosed = true;
      });
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const gatewayAddress = httpServer.address();
    if (!gatewayAddress || typeof gatewayAddress === "string") {
      throw new Error("expected Gateway test address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        }),
    );

    const controller = new AbortController();
    const emitStatus = vi.fn(async () => undefined);
    const running = invokeNodeDesktopStream({
      paramsJSON: JSON.stringify({
        ticket: TICKET,
        attachPath: `/node-desktop/attach?ticket=${TICKET}`,
      }),
      gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
      config: { enabled: true, port: rfbAddress.port },
      signal: controller.signal,
      emitStatus,
    });
    await vi.waitFor(() => expect(emitStatus).toHaveBeenCalledWith("desktop stream attached\n"));

    controller.abort();

    await expect(running).resolves.toBeUndefined();
    await vi.waitFor(() => expect(streamClosed).toBe(true));
    await vi.waitFor(() => expect(rfbPeers.size).toBe(0));
  });
});
