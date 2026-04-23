import { describe, expect, it, vi } from "vitest";
import {
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import { waitForSlackSocketDisconnect } from "./reconnect-policy.js";

class FakeEmitter {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const bucket = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

describe("slack socket reconnect helpers", () => {
  it("marks socket mode healthy without seeding event liveness on connect", () => {
    const setStatus = vi.fn();

    publishSlackConnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        lastConnectedAt: expect.any(Number),
        healthState: "healthy",
        lastError: null,
      }),
    );
    expect(setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ lastEventAt: expect.any(Number) }),
    );
  });

  it("marks socket mode disconnected when an error closes the socket", () => {
    const setStatus = vi.fn();
    const err = new Error("dns down");

    publishSlackDisconnectedStatus(setStatus, err);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: expect.any(Number),
        error: "dns down",
      },
      lastError: "dns down",
    });
  });

  it("marks socket mode disconnected without error when the socket closes cleanly", () => {
    const setStatus = vi.fn();

    publishSlackDisconnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: expect.any(Number),
      },
      lastError: null,
    });
  });

  it("resolves disconnect waiter on socket disconnect event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("disconnected");

    await expect(waiter).resolves.toEqual({ event: "disconnect" });
  });

  it("resolves disconnect waiter on socket error event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("dns down");

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("error", err);

    await expect(waiter).resolves.toEqual({ event: "error", error: err });
  });

  it("installs the disconnect waiter before socket start completes", async () => {
    const client = new FakeEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(async () => {
        client.emit("disconnected");
      }),
    };
    const onStarted = vi.fn();

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted,
      }),
    ).resolves.toEqual({ event: "disconnect" });

    expect(app.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("cancels the disconnect waiter when onStarted throws", async () => {
    const client = new FakeEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockResolvedValue(undefined),
    };
    const err = new Error("status sink failed");

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted: () => {
          throw err;
        },
      }),
    ).rejects.toThrow("status sink failed");

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("preserves error payload from unable_to_socket_mode_start event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("invalid_auth");

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("unable_to_socket_mode_start", err);

    await expect(waiter).resolves.toEqual({
      event: "unable_to_socket_mode_start",
      error: err,
    });
  });

  it("marks the socket client as shutting down before stop runs", async () => {
    const app = {
      receiver: { client: { shuttingDown: false } },
      stop: vi.fn().mockImplementation(async () => {
        expect(app.receiver.client.shuttingDown).toBe(true);
      }),
    };

    await gracefulStopSlackApp(app);

    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.receiver.client.shuttingDown).toBe(true);
  });
});
