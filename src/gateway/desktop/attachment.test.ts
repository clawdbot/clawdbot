import net from "node:net";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
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

  it.each(["acquire", "activate"] as const)("refreshes idle cleanup after %s", async (method) => {
    vi.useFakeTimers();
    const teardown = vi.fn(async () => undefined);
    const registry = createDesktopSessionRegistry({ lingerMs: 25 });
    const request = {
      sourceKey: "node:one",
      ownerEpoch: 1,
      teardown,
      start: async () => ({ attachment: { kind: "tcp", host: "127.0.0.1", port: 5900 } as const }),
    };
    await registry[method](request);
    await vi.advanceTimersByTimeAsync(20);
    await registry[method](request);
    await vi.advanceTimersByTimeAsync(20);
    expect(teardown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5);
    expect(teardown).toHaveBeenCalled();
    await registry.stopAll();
  });

  it.each(["stop", "stopAll"] as const)("%s joins teardown already in progress", async (method) => {
    const registry = createDesktopSessionRegistry();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    await registry.activate({
      sourceKey: "node:one",
      ownerEpoch: 1,
      teardown: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const completed: string[] = [];
    let reentrantStop: Promise<void> | undefined;
    registry.attachObserver("node:one", {
      ownerEpoch: 1,
      control: false,
      close: () => {
        reentrantStop = registry.stop("node:one", 1).then(() => {
          completed.push("observer");
        });
      },
    });
    const first = registry.stop("node:one", 1);
    await entered.promise;
    const second = (method === "stop" ? registry.stop("node:one", 1) : registry.stopAll()).then(
      () => {
        completed.push("second");
      },
    );
    try {
      await setImmediate();
      expect(completed).toEqual([]);
      expect(reentrantStop).toBeDefined();
      expect(registry.reserveObserver("node:one", 1)).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.all([first, second, reentrantStop]);
    }
    expect(completed.toSorted()).toEqual(["observer", "second"]);
  });

  it.each([1, 2])("waits for stopped resources before acquiring epoch %s", async (ownerEpoch) => {
    const registry = createDesktopSessionRegistry();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const attachment = { kind: "tcp", host: "127.0.0.1", port: 5900 } as const;
    await registry.acquire({
      sourceKey: "node:one",
      ownerEpoch: 1,
      start: async () => ({ attachment }),
      teardown: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const stopping = registry.stop("node:one", 1);
    await entered.promise;
    const start = vi.fn(async () => ({ attachment }));
    const acquiring = registry.acquire({ sourceKey: "node:one", ownerEpoch, start });
    try {
      await setImmediate();
      expect(start).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([stopping, acquiring]);
      await registry.stopAll();
    }
    expect(start).toHaveBeenCalledOnce();
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
