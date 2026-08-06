import { setImmediate as waitForImmediate } from "node:timers/promises";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
  GatewayClient,
  GatewayClientRequestTimeoutError,
  type GatewayClientOptions,
} from "../../../../packages/gateway-client/src/index.js";

type RequestFrame = {
  id: string;
  method: string;
  params?: unknown;
  type: "req";
};

const clients: GatewayClient[] = [];
let server: WebSocketServer | undefined;

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Buffer.from(new Uint8Array(data)).toString("utf8");
}

function parseRequest(data: RawData): RequestFrame {
  return JSON.parse(rawDataToString(data)) as RequestFrame;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function enableFakeTimeAfterSocketEstablishment(): void {
  vi.useFakeTimers({
    toFake: ["Date", "clearInterval", "clearTimeout", "setInterval", "setTimeout"],
  });
}

async function flushSocketIo(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await waitForImmediate();
  }
}

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await flushSocketIo(1);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function listen(
  onConnection: (socket: WebSocket, request: RequestFrame) => void,
): Promise<string> {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (data) => onConnection(socket, parseRequest(data)));
  });
  await new Promise<void>((resolve) => {
    server?.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("gateway client defaults server did not get a TCP address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

function sendChallenge(socket: WebSocket, sequence = 1): void {
  socket.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      seq: sequence,
      payload: { nonce: `defaults-${sequence}`, ts: 1_777_777_777_000 },
    }),
  );
}

function sendHello(socket: WebSocket, requestId: string, tickIntervalMs: number): void {
  socket.send(
    JSON.stringify({
      type: "res",
      id: requestId,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: PROTOCOL_VERSION,
        server: { version: "gateway-client-defaults", connId: "defaults-connection" },
        features: { methods: ["chat.send", "status"], events: ["tick"] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 1, health: 1 },
          uptimeMs: 1,
        },
        auth: { role: "operator", scopes: ["operator.admin"] },
        policy: {
          maxPayload: 512 * 1024,
          maxBufferedBytes: 1024 * 1024,
          tickIntervalMs,
        },
      },
    }),
  );
}

async function connectWithFakeTime(params: {
  clientOptions?: Omit<GatewayClientOptions, "onConnectError" | "onHelloOk" | "url">;
  onRequest?: (socket: WebSocket, request: RequestFrame) => void;
  tickIntervalMs: number;
}): Promise<{ client: GatewayClient; socket: WebSocket }> {
  const socketReady = createDeferred<WebSocket>();
  const helloReady = createDeferred<void>();
  const url = await listen((socket, request) => {
    if (request.method === "connect") {
      sendHello(socket, request.id, params.tickIntervalMs);
      return;
    }
    params.onRequest?.(socket, request);
  });
  server?.once("connection", (socket) => {
    // The real transport is established before timers become deterministic.
    enableFakeTimeAfterSocketEstablishment();
    socketReady.resolve(socket);
  });
  const client = new GatewayClient({
    ...params.clientOptions,
    url,
    onHelloOk: () => helloReady.resolve(undefined),
    onConnectError: (error) => helloReady.reject(error),
  });
  clients.push(client);
  client.start();

  const socket = await socketReady.promise;
  await flushSocketIo();
  sendChallenge(socket);
  await helloReady.promise;
  return { client, socket };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
  vi.useRealTimers();
  if (server) {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
  }
});

describe("GatewayClient transport defaults", () => {
  it("uses a 30 second default request timeout", async () => {
    const requestReady = createDeferred<void>();
    const { client } = await connectWithFakeTime({
      tickIntervalMs: 60_000,
      onRequest: (_socket, request) => {
        if (request.method === "status") {
          requestReady.resolve(undefined);
        }
      },
    });

    let settled = false;
    const outcome = client.request("status").then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await requestReady.promise;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(GatewayClientRequestTimeoutError);
    expect(error).toMatchObject({
      message: "gateway request timeout for status",
      method: "status",
      requestSent: true,
      timeoutMs: 30_000,
    });
  });

  it("enforces the 15 second connect-challenge watchdog", async () => {
    const socketReady = createDeferred<WebSocket>();
    const errors: Error[] = [];
    const url = await listen(() => {});
    server?.once("connection", (socket) => {
      enableFakeTimeAfterSocketEstablishment();
      socketReady.resolve(socket);
    });
    const client = new GatewayClient({
      url,
      onConnectError: (error) => errors.push(error),
    });
    clients.push(client);
    client.start();

    const socket = await socketReady.promise;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    await flushSocketIo();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(
      "gateway connect challenge timeout (waited 15000ms, limit 15000ms)",
    );
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "connect challenge timeout",
    });
  });

  it("reconnects after 1/2/4 second delays capped at 30 seconds", async () => {
    const sockets: WebSocket[] = [];
    const closeEvents: Array<{ code: number; reason: string }> = [];
    const firstSocket = createDeferred<WebSocket>();
    const url = await listen(() => {});
    server?.on("connection", (socket) => {
      sockets.push(socket);
      if (sockets.length === 1) {
        enableFakeTimeAfterSocketEstablishment();
        firstSocket.resolve(socket);
        return;
      }
      waitForImmediate().then(() => socket.close(1012, "retry"));
    });
    const client = new GatewayClient({
      url,
      onClose: (code, reason) => closeEvents.push({ code, reason }),
    });
    clients.push(client);
    client.start();

    const initialSocket = await firstSocket.promise;
    await flushSocketIo();
    initialSocket.close(1012, "retry");

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, delayMs] of expectedDelays.entries()) {
      await waitForCondition(() => closeEvents.length >= index + 1, `close event ${index + 1}`);
      const connectionCount = sockets.length;

      await vi.advanceTimersByTimeAsync(delayMs - 1);
      await flushSocketIo();
      expect(sockets).toHaveLength(connectionCount);

      await vi.advanceTimersByTimeAsync(1);
      await waitForCondition(
        () => sockets.length === connectionCount + 1,
        `reconnect ${index + 1}`,
      );
    }

    expect(closeEvents).toHaveLength(expectedDelays.length);
    expect(closeEvents).toEqual(expectedDelays.map(() => ({ code: 1012, reason: "retry" })));
  });

  it("uses the server tick interval and closes missing ticks with code 4000", async () => {
    const closeEvents: Array<{ code: number; reason: string }> = [];
    const { socket } = await connectWithFakeTime({
      tickIntervalMs: 50,
      clientOptions: {
        tickWatchMinIntervalMs: 1,
        onClose: (code, reason) => closeEvents.push({ code, reason }),
      },
    });
    const serverClose = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(closeEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    await expect(serverClose).resolves.toEqual({ code: 4000, reason: "tick timeout" });
    await waitForCondition(() => closeEvents.length === 1, "client tick-timeout close callback");
    expect(closeEvents[0]).toEqual({ code: 4000, reason: "tick timeout" });
  });

  it("keeps an unbounded request alive while inbound ticks continue", async () => {
    const requestReady = createDeferred<RequestFrame>();
    const closeEvents: Array<{ code: number; reason: string }> = [];
    const { client, socket } = await connectWithFakeTime({
      tickIntervalMs: 5_000,
      clientOptions: {
        tickWatchMinIntervalMs: 1,
        onClose: (code, reason) => closeEvents.push({ code, reason }),
      },
      onRequest: (_socket, request) => {
        if (request.method === "chat.send") {
          requestReady.resolve(request);
        }
      },
    });
    const request = client.request<{ status: string }>(
      "chat.send",
      { message: "defaults" },
      { timeoutMs: null },
    );
    const requestFrame = await requestReady.promise;

    for (let sequence = 1; sequence <= 8; sequence += 1) {
      await vi.advanceTimersByTimeAsync(4_000);
      socket.send(
        JSON.stringify({
          type: "event",
          event: "tick",
          seq: sequence,
          payload: { ts: Date.now() },
        }),
      );
      await flushSocketIo();
    }

    expect(closeEvents).toEqual([]);
    socket.send(
      JSON.stringify({
        type: "res",
        id: requestFrame.id,
        ok: true,
        payload: { status: "ok" },
      }),
    );
    await expect(request).resolves.toEqual({ status: "ok" });
  });
});
