import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  invokeNodeDesktopStream,
  invokeNodeWorkerDesktopStream,
} from "./desktop-stream-command.js";

const TICKET = "a".repeat(48);
const cleanups: Array<() => Promise<void>> = [];

async function listenRfbSecurity(securityType: number): Promise<number> {
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.on("error", handleExpectedPeerTeardownError);
    socket.write(Buffer.from("RFB 003.008\n", "ascii"));
    socket.once("data", () => socket.write(Buffer.from([1, securityType])));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected RFB test address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        for (const peer of peers) {
          peer.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return address.port;
}

function handleExpectedPeerTeardownError(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("node desktop stream command", () => {
  it.each([
    ["caller-selected host", { host: "192.0.2.10" }],
    ["relative password path", { passwordFilePath: "vnc.password" }],
    ["invalid RFB port", { port: 65_536 }],
  ])("rejects worker stream payload with %s", async (_name, override) => {
    await expect(
      invokeNodeWorkerDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          port: 5900,
          ...override,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("INVALID_REQUEST");
  });

  it("refuses an unauthenticated provider RFB endpoint before Gateway attach", async () => {
    const port = await listenRfbSecurity(1);

    await expect(
      invokeNodeWorkerDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          port,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("refusing unauthenticated loopback RFB server");
  });

  it("bounds the provider-owned VNC password file", async () => {
    const port = await listenRfbSecurity(2);
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "desktop-password-"));
    const oversized = path.join(root, "oversized");
    await fs.writeFile(oversized, "x".repeat(4 * 1024 + 1));
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));

    for (const [passwordFilePath, message] of [
      [root, "must be a regular file"],
      [oversized, "is too large"],
    ] as const) {
      await expect(
        invokeNodeWorkerDesktopStream({
          paramsJSON: JSON.stringify({
            ticket: TICKET,
            attachPath: `/node-desktop/attach?ticket=${TICKET}`,
            port,
            passwordFilePath,
          }),
          gatewayUrl: "ws://127.0.0.1:1",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("honors cancellation before reading a VNC password file", async () => {
    const port = await listenRfbSecurity(2);
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "desktop-password-"));
    const passwordFilePath = path.join(root, "password");
    await fs.writeFile(passwordFilePath, "secret");
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    controller.abort(new Error("desktop owner closed"));

    await expect(
      invokeNodeWorkerDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          port,
          passwordFilePath,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        signal: controller.signal,
      }),
    ).rejects.toThrow("desktop owner closed");
  });

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

  it("authenticates public and worker attaches and tears down both sockets when cancelled", async () => {
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
    const streams: Array<{
      accessHeaders: [string | undefined, string | undefined];
      closed: boolean;
    }> = [];
    wss.on("connection", (ws, request) => {
      const stream = {
        accessHeaders: [
          request.headers["cf-access-client-id"],
          request.headers["cf-access-client-secret"],
        ] as [string | undefined, string | undefined],
        closed: false,
      };
      streams.push(stream);
      ws.once("close", () => {
        stream.closed = true;
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

    for (const kind of ["public", "worker"] as const) {
      const controller = new AbortController();
      const emitStatus = vi.fn(async () => undefined);
      const connection = {
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          ...(kind === "worker" ? { port: rfbAddress.port } : {}),
        }),
        gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
        gatewayCloudflareAccess: {
          clientId: "desktop-client-id",
          clientSecret: "desktop-client-secret",
        },
        signal: controller.signal,
      };
      const running =
        kind === "worker"
          ? invokeNodeWorkerDesktopStream(connection)
          : invokeNodeDesktopStream({
              ...connection,
              config: { enabled: true, port: rfbAddress.port },
              emitStatus,
            });
      await vi.waitFor(() => expect(streams).toHaveLength(kind === "public" ? 1 : 2));
      const stream = streams.at(-1);
      if (!stream) {
        throw new Error("expected desktop stream attachment");
      }
      expect(stream.accessHeaders).toEqual(["desktop-client-id", "desktop-client-secret"]);
      if (kind === "public") {
        expect(emitStatus).toHaveBeenCalledWith("desktop stream attached\n");
      }

      controller.abort();

      await expect(running).resolves.toBeUndefined();
      await vi.waitFor(() => expect(stream.closed).toBe(true));
      await vi.waitFor(() => expect(rfbPeers.size).toBe(0));
    }
  });
});
