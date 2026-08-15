import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRfbAttachment } from "./attachment.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("RFB attachments", () => {
  it("connects a loopback TCP attachment", async () => {
    const accepted = new Promise<void>((resolve) => {
      const server = net.createServer((socket) => {
        sockets.push(socket);
        resolve();
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
    });
    const server = servers[0];
    if (!server) {
      throw new Error("expected TCP test server");
    }
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP test server address");
    }

    sockets.push(connectRfbAttachment({ kind: "tcp", host: "127.0.0.1", port: address.port }));

    await expect(accepted).resolves.toBeUndefined();
  });

  it("does not claim a stream that closed before observer redemption", async () => {
    const registry = createDesktopSessionRegistry();
    await registry.acquire({
      sourceKey: "node:one",
      ownerEpoch: 1,
      start: async () => ({
        attachment: { kind: "tcp", host: "127.0.0.1", port: 5900 },
      }),
    });
    const stream = new PassThrough();
    const reservation = registry.reserveObserver("node:one", 1);
    if (!reservation) {
      throw new Error("expected observer reservation");
    }
    const attachment = registry.publishStream({
      sourceKey: "node:one",
      ownerEpoch: 1,
      stream,
      reservation,
    });
    if (!attachment) {
      throw new Error("expected stream attachment");
    }
    const closed = new Promise<void>((resolve) => {
      stream.once("close", () => resolve());
    });
    stream.destroy();
    await closed;

    expect(registry.claimStream(attachment)).toBeUndefined();
    await registry.stopAll();
  });

  it("refreshes the cleanup deadline when an idle stream session is reactivated", async () => {
    vi.useFakeTimers();
    const teardown = vi.fn(async () => undefined);
    const registry = createDesktopSessionRegistry({ lingerMs: 25 });
    await registry.activate({ sourceKey: "node:one", ownerEpoch: 1, teardown });
    await vi.advanceTimersByTimeAsync(20);
    await registry.activate({ sourceKey: "node:one", ownerEpoch: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(teardown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5);
    expect(teardown).toHaveBeenCalled();
  });

  it("bounds pending observer reservations before streams are started", async () => {
    const registry = createDesktopSessionRegistry();
    await registry.activate({ sourceKey: "node:one", ownerEpoch: 1 });
    const reservations = Array.from({ length: 8 }, () => registry.reserveObserver("node:one", 1));
    expect(reservations.every(Boolean)).toBe(true);
    expect(registry.reserveObserver("node:one", 1)).toBeUndefined();

    reservations[0]?.release();
    expect(registry.reserveObserver("node:one", 1)).toBeDefined();
    await registry.stopAll();
  });

  it("keeps a reserved observer session alive and rearms cleanup on release", async () => {
    vi.useFakeTimers();
    const teardown = vi.fn(async () => undefined);
    const registry = createDesktopSessionRegistry({ lingerMs: 25 });
    await registry.activate({ sourceKey: "node:one", ownerEpoch: 1, teardown });
    const reservation = registry.reserveObserver("node:one", 1);
    if (!reservation) {
      throw new Error("expected observer reservation");
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(teardown).not.toHaveBeenCalled();

    reservation.release();
    await vi.advanceTimersByTimeAsync(25);
    expect(teardown).toHaveBeenCalled();
  });

  it("does not linger-stop a reservation when another observer disconnects", async () => {
    vi.useFakeTimers();
    const teardown = vi.fn(async () => undefined);
    const registry = createDesktopSessionRegistry({ lingerMs: 25 });
    await registry.activate({ sourceKey: "node:one", ownerEpoch: 1, teardown });
    const observer = registry.attachObserver("node:one", {
      ownerEpoch: 1,
      control: false,
      close: () => {},
    });
    const reservation = registry.reserveObserver("node:one", 1);
    if (!observer || !reservation) {
      throw new Error("expected observer and reservation");
    }
    observer.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(teardown).not.toHaveBeenCalled();

    reservation.release();
    await vi.advanceTimersByTimeAsync(25);
    expect(teardown).toHaveBeenCalled();
  });
});
