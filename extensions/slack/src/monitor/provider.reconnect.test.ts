import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketReconnectMessage,
  formatSlackSocketStartRetryMessage,
} from "./provider.js";
import { formatUnknownError, waitForSlackSocketDisconnect } from "./reconnect-policy.js";

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

function statusCallAt(setStatus: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const call = setStatus.mock.calls[index];
  if (!call) {
    throw new Error(`expected status call ${index}`);
  }
  const [status] = call;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`expected status call ${index} payload`);
  }
  return status as Record<string, unknown>;
}

describe("slack socket reconnect helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks socket mode healthy without seeding event liveness on connect", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_000);

    publishSlackConnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    const status = statusCallAt(setStatus, 0);
    expect(status?.connected).toBe(true);
    expect(status?.lastConnectedAt).toBe(1_711_406_400_000);
    expect(status?.healthState).toBe("healthy");
    expect(status?.lastError).toBeNull();
    expect(status).not.toHaveProperty("lastEventAt");
  });

  it("marks socket mode disconnected when an error closes the socket", () => {
    const setStatus = vi.fn();
    const err = new Error("dns down");
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_401_000);

    publishSlackDisconnectedStatus(setStatus, err);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: 1_711_406_401_000,
        error: "dns down",
      },
      lastError: "dns down",
    });
  });

  it("marks socket mode disconnected without error when the socket closes cleanly", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_402_000);

    publishSlackDisconnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: 1_711_406_402_000,
      },
      lastError: null,
    });
  });

  it("formats recoverable disconnects as a single reconnect status line", () => {
    expect(
      formatSlackSocketReconnectMessage({
        event: "disconnect",
        attempt: 1,
        maxAttempts: 12,
        delayMs: 2_340,
      }),
    ).toBe("slack socket disconnected (disconnect); reconnecting in 2s (attempt 1/12)");
  });

  it("formats missing and unserializable socket errors without leaking undefined", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatUnknownError(undefined)).toBe("no error detail");
    expect(formatUnknownError(null)).toBe("no error detail");
    expect(formatUnknownError("")).toBe("no error detail");
    expect(formatUnknownError(new Error(""))).toBe("Error");
    expect(formatUnknownError(circular)).toBe('{"self":"[Circular]"}');
  });

  it("formats structured Slack socket errors", () => {
    expect(
      formatUnknownError({
        code: "slack_webapi_platform_error",
        data: {
          error: "missing_scope",
          needed: "connections:write",
          response_metadata: {
            messages: ["[ERROR] missing required scope"],
          },
        },
      }),
    ).toBe(
      "code: slack_webapi_platform_error; slack error: missing_scope; needed: connections:write; slack message: [ERROR] missing required scope",
    );
  });

  it("formats socket start retries with an explicit reason field", () => {
    expect(
      formatSlackSocketStartRetryMessage({
        attempt: 1,
        maxAttempts: 12,
        delayMs: 2_340,
        error: undefined,
      }),
    ).toBe(
      'slack socket mode failed to start; retry 1/12 in 2s reason="Slack Socket Mode start failed without error detail"',
    );
  });

  it("includes last SDK log context when start errors have no detail", () => {
    expect(
      formatSlackSocketStartRetryMessage({
        attempt: 1,
        maxAttempts: 12,
        delayMs: 2_340,
        error: undefined,
        sdkContext: "socket-mode:SlackWebSocket:1 Failed to retrieve WSS URL",
      }),
    ).toBe(
      'slack socket mode failed to start; retry 1/12 in 2s reason="Slack Socket Mode start failed without error detail; last SDK log: socket-mode:SlackWebSocket:1 Failed to retrieve WSS URL"',
    );
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

  it("uses socket start event error when Bolt rejects without detail", async () => {
    const client = new FakeEmitter();
    const err = new Error("missing_scope");
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(async () => {
        client.emit("unable_to_socket_mode_start", err);
        throw undefined;
      }),
    };

    await expect(startSlackSocketAndWaitForDisconnect({ app: app as never })).rejects.toThrow(
      "missing_scope",
    );

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
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
