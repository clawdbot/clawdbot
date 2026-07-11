// Gateway Client tests cover client.watchdog behavior.
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GatewayClient, resolveGatewayClientConnectChallengeTimeoutMs } from "./client.js";
import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  MAX_SAFE_TIMEOUT_DELAY_MS,
  MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
  MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
} from "./timeouts.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((entry) => Buffer.from(entry))).toString("utf8");
  }
  return String(data);
}

function createOpenGatewayClient(requestTimeoutMs: number): {
  client: GatewayClient;
  send: ReturnType<typeof vi.fn>;
} {
  const client = new GatewayClient({
    requestTimeoutMs,
  });
  const send = vi.fn();
  (
    client as unknown as {
      ws: WebSocket | { readyState: number; send: () => void; close: () => void };
    }
  ).ws = {
    readyState: WebSocket.OPEN,
    send,
    close: vi.fn(),
  };
  return { client, send };
}

function getPendingCount(client: GatewayClient): number {
  return (client as unknown as { pending: Map<string, unknown> }).pending.size;
}

function trackSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

function createWatchedGatewayClient(): {
  client: GatewayClient;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const client = new GatewayClient({
    requestTimeoutMs: 100,
    tickWatchMinIntervalMs: 5,
    tickWatchTimeoutMs: 10,
  });
  const close = vi.fn();
  const send = vi.fn();
  Object.assign(client as unknown as { ws: unknown; tickIntervalMs: number; lastTick: number }, {
    ws: {
      readyState: WebSocket.OPEN,
      send,
      close,
      terminate: vi.fn(),
    },
    tickIntervalMs: 5,
    lastTick: Date.now(),
  });
  (client as unknown as { startTickWatch: () => void }).startTickWatch();
  return { client, close, send };
}

function handleGatewayMessage(client: GatewayClient, payload: Record<string, unknown>): void {
  (client as unknown as { handleMessage: (raw: string) => void }).handleMessage(
    JSON.stringify(payload),
  );
}

async function stopSyntheticClient(client: GatewayClient): Promise<void> {
  client.stop();
  await vi.advanceTimersByTimeAsync(250);
}

describe("GatewayClient", () => {
  let wss: WebSocketServer | null = null;
  let httpsServer: ReturnType<typeof createHttpsServer> | null = null;

  afterEach(async () => {
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss?.close(() => resolve());
      });
      wss = null;
    }
    if (httpsServer) {
      httpsServer.closeAllConnections?.();
      httpsServer.closeIdleConnections?.();
      await new Promise<void>((resolve) => {
        httpsServer?.close(() => resolve());
      });
      httpsServer = null;
    }
  });

  test("sends the configured websocket origin", async () => {
    const port = await getFreePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    const receivedOrigin = new Promise<string | undefined>((resolve) => {
      wss?.once("connection", (_socket, request) => resolve(request.headers.origin));
    });
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      connectChallengeTimeoutMs: 0,
    });
    client.start();

    await expect(receivedOrigin).resolves.toBe(`http://127.0.0.1:${port}`);
    client.stop();
  });

  test("prefers connectChallengeTimeoutMs and still honors the legacy alias", () => {
    expect(resolveGatewayClientConnectChallengeTimeoutMs({})).toBe(
      DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
    );
    expect(resolveGatewayClientConnectChallengeTimeoutMs({ connectDelayMs: 0 })).toBe(
      MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    );
    expect(resolveGatewayClientConnectChallengeTimeoutMs({ connectDelayMs: 20_000 })).toBe(
      MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
    );
    expect(
      resolveGatewayClientConnectChallengeTimeoutMs({
        connectDelayMs: 2_000,
        connectChallengeTimeoutMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      resolveGatewayClientConnectChallengeTimeoutMs({
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
    expect(
      resolveGatewayClientConnectChallengeTimeoutMs({
        connectChallengeTimeoutMs: 45_000,
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
    expect(
      resolveGatewayClientConnectChallengeTimeoutMs({
        env: { OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "6000" },
      }),
    ).toBe(6_000);
  });

  test("returns non-sensitive connection metadata", () => {
    const client = new GatewayClient({
      clientName: "cli",
      mode: "backend",
      preauthHandshakeTimeoutMs: 30_000,
      deviceIdentity: {
        deviceId: "device-1",
        privateKeyPem: "private-key",
        publicKeyPem: "public-key",
      },
    });

    expect(client.getConnectionMetadata()).toEqual({
      clientName: "cli",
      hasDeviceIdentity: true,
      mode: "backend",
      preauthHandshakeTimeoutMs: 30_000,
    });
  });

  test("rejects an unbounded request, reconnects, and does not replay it", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss = server;
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("websocket server address unavailable");
    }

    let connectionCount = 0;
    const methodsByConnection = new Map<number, string[]>();
    server.on("connection", (socket) => {
      connectionCount += 1;
      const connectionNumber = connectionCount;
      methodsByConnection.set(connectionNumber, []);
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          seq: connectionNumber,
          payload: { nonce: `nonce-${connectionNumber}` },
        }),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
        methodsByConnection.get(connectionNumber)?.push(frame.method);
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 4,
                server: { version: "watchdog-test", connId: `c${connectionNumber}` },
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
                  tickIntervalMs: 20,
                },
              },
            }),
          );
          return;
        }
        if (frame.method === "status") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { status: "ok" },
            }),
          );
        }
      });
    });

    const firstHelloResolvers: Array<() => void> = [];
    const secondHelloResolvers: Array<() => void> = [];
    const firstHello = new Promise<void>((resolve) => {
      firstHelloResolvers.push(resolve);
    });
    const secondHello = new Promise<void>((resolve) => {
      secondHelloResolvers.push(resolve);
    });
    const resolveFirstHello = firstHelloResolvers.at(0);
    const resolveSecondHello = secondHelloResolvers.at(0);
    if (!resolveFirstHello || !resolveSecondHello) {
      throw new Error("hello promises did not initialize their resolvers");
    }
    const closeEvents: Array<{ code: number; reason: string }> = [];
    let helloCount = 0;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}`,
      tickWatchMinIntervalMs: 5,
      onHelloOk: () => {
        helloCount += 1;
        if (helloCount === 1) {
          // Keep the real reconnect lifecycle fast without changing production defaults.
          (client as unknown as { backoffMs: number }).backoffMs = 10;
          resolveFirstHello();
          return;
        }
        resolveSecondHello();
      },
      onClose: (code, reason) => closeEvents.push({ code, reason }),
    });

    try {
      client.start();
      await firstHello;

      const stalledRequest = client.request(
        "chat.send",
        { text: "send once" },
        {
          expectFinal: true,
        },
      );
      void stalledRequest.catch(() => {});

      await expect(stalledRequest).rejects.toThrow("gateway closed (4000): tick timeout");
      await secondHello;
      await expect(client.request("status")).resolves.toEqual({ status: "ok" });

      expect(closeEvents[0]).toEqual({ code: 4000, reason: "tick timeout" });
      expect(methodsByConnection.get(1)).toEqual(["connect", "chat.send"]);
      expect(methodsByConnection.get(2)).toEqual(["connect", "status"]);
      expect(
        [...methodsByConnection.values()].flat().filter((method) => method === "chat.send"),
      ).toHaveLength(1);
    } finally {
      await client.stopAndWait();
    }
  }, 5000);

  test("lets finite pending requests own their timeout when ticks are missing", async () => {
    vi.useFakeTimers();
    try {
      const { client, close } = createWatchedGatewayClient();
      const request = client.request("status", undefined, { timeoutMs: 100 });
      const requestExpectation = expect(request).rejects.toThrow(
        "gateway request timeout for status",
      );
      await vi.advanceTimersByTimeAsync(20);

      expect(close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(80);
      await requestExpectation;
      await vi.advanceTimersByTimeAsync(5);

      expect(close).toHaveBeenCalledWith(4000, "tick timeout");
      await stopSyntheticClient(client);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    {
      label: "an explicit timeoutMs: null",
      method: "status",
      options: { timeoutMs: null },
    },
    {
      label: "an implicit expectFinal",
      method: "chat.send",
      options: { expectFinal: true },
    },
  ])("keeps the watchdog active for $label request", async ({ method, options }) => {
    vi.useFakeTimers();
    try {
      const { client, close } = createWatchedGatewayClient();
      const request = client.request(method, undefined, options);
      const requestExpectation = expect(request).rejects.toThrow("gateway client stopped");

      await vi.advanceTimersByTimeAsync(20);

      expect(close).toHaveBeenCalledWith(4000, "tick timeout");
      await stopSyntheticClient(client);
      await requestExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps the watchdog active for mixed finite and unbounded requests", async () => {
    vi.useFakeTimers();
    try {
      const { client, close } = createWatchedGatewayClient();
      const requests = [
        client.request("status", undefined, { timeoutMs: 100 }),
        client.request("chat.send", undefined, { expectFinal: true }),
      ];
      const settlements = Promise.allSettled(requests);

      await vi.advanceTimersByTimeAsync(20);

      expect(close).toHaveBeenCalledWith(4000, "tick timeout");
      await stopSyntheticClient(client);
      await expect(settlements).resolves.toEqual([
        expect.objectContaining({ status: "rejected" }),
        expect.objectContaining({ status: "rejected" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps an unbounded request alive while inbound ticks continue", async () => {
    vi.useFakeTimers();
    try {
      const { client, close, send } = createWatchedGatewayClient();
      const request = client.request<{ status: string }>("chat.send", undefined, {
        expectFinal: true,
      });
      const requestFrame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };

      for (let seq = 1; seq <= 4; seq += 1) {
        await vi.advanceTimersByTimeAsync(5);
        handleGatewayMessage(client, { type: "event", event: "tick", seq, payload: {} });
      }

      expect(close).not.toHaveBeenCalled();
      handleGatewayMessage(client, {
        type: "res",
        id: requestFrame.id,
        ok: true,
        payload: { status: "ok" },
      });
      await expect(request).resolves.toEqual({ status: "ok" });
      await stopSyntheticClient(client);
    } finally {
      vi.useRealTimers();
    }
  });

  test("honors explicit tick watchdog timeout threshold", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({
        tickWatchMinIntervalMs: 5,
        tickWatchTimeoutMs: 50,
      });
      const close = vi.fn();
      Object.assign(
        client as unknown as { ws: unknown; tickIntervalMs: number; lastTick: number },
        {
          ws: {
            readyState: WebSocket.OPEN,
            send: vi.fn(),
            close,
          },
          tickIntervalMs: 5,
          lastTick: Date.now(),
        },
      );

      (
        client as unknown as {
          startTickWatch: () => void;
        }
      ).startTickWatch();
      await vi.advanceTimersByTimeAsync(20);
      expect(close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(35);
      expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clamps oversized tick watchdog intervals before scheduling", () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const client = new GatewayClient({
        tickWatchMinIntervalMs: 5,
      });
      Object.assign(
        client as unknown as { ws: unknown; tickIntervalMs: number; lastTick: number },
        {
          ws: {
            readyState: WebSocket.OPEN,
            send: vi.fn(),
            close: vi.fn(),
          },
          tickIntervalMs: Number.MAX_SAFE_INTEGER,
          lastTick: Date.now(),
        },
      );

      (
        client as unknown as {
          startTickWatch: () => void;
        }
      ).startTickWatch();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("times out unresolved requests and clears pending state", async () => {
    vi.useFakeTimers();
    try {
      const { client, send } = createOpenGatewayClient(25);

      const requestPromise = client.request("status");
      const requestExpectation = expect(requestPromise).rejects.toThrow(
        "gateway request timeout for status",
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(getPendingCount(client)).toBe(1);

      await vi.advanceTimersByTimeAsync(25);

      await requestExpectation;
      expect(getPendingCount(client)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cleans pending request state when websocket send throws", async () => {
    const client = new GatewayClient({
      requestTimeoutMs: 25,
    });
    const sendError = new Error("synthetic send failure");
    (
      client as unknown as {
        ws: WebSocket | { readyState: number; send: () => void; close: () => void };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(() => {
        throw sendError;
      }),
      close: vi.fn(),
    };

    await expect(client.request("status")).rejects.toThrow("synthetic send failure");
    expect(getPendingCount(client)).toBe(0);
  });

  test("does not auto-timeout expectFinal requests", async () => {
    vi.useFakeTimers();
    try {
      const { client, send } = createOpenGatewayClient(25);

      const requestPromise = client.request("chat.send", undefined, { expectFinal: true });
      const isSettled = trackSettlement(requestPromise);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);

      expect(isSettled()).toBe(false);
      expect(getPendingCount(client)).toBe(1);

      client.stop();
      await expect(requestPromise).rejects.toThrow("gateway client stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifies accepted expectFinal requests while continuing to wait for final", async () => {
    const client = new GatewayClient({
      requestTimeoutMs: 25,
    });
    const send = vi.fn();
    (
      client as unknown as {
        ws: WebSocket | { readyState: number; send: (data: string) => void; close: () => void };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send,
      close: vi.fn(),
    };

    const onAccepted = vi.fn();
    const requestPromise = client.request<{ status: string }>("agent", undefined, {
      expectFinal: true,
      onAccepted,
    });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };

    (
      client as unknown as {
        handleMessage: (raw: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { status: "accepted", runId: "run-1" },
      }),
    );

    expect(onAccepted).toHaveBeenCalledWith({ status: "accepted", runId: "run-1" });
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);

    (
      client as unknown as {
        handleMessage: (raw: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { status: "ok" },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ status: "ok" });
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  test("aborts in-flight requests from caller AbortSignal", async () => {
    const client = new GatewayClient({
      requestTimeoutMs: 25,
    });
    const send = vi.fn();
    (
      client as unknown as {
        ws: WebSocket | { readyState: number; send: () => void; close: () => void };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send,
      close: vi.fn(),
    };

    const controller = new AbortController();
    const requestPromise = client.request("status", undefined, {
      signal: controller.signal,
      timeoutMs: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);

    controller.abort();

    await expect(requestPromise).rejects.toThrow("gateway request aborted for status");
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  test("clamps oversized explicit request timeouts before scheduling", async () => {
    vi.useFakeTimers();
    try {
      const { client } = createOpenGatewayClient(25);

      const requestPromise = client.request("status", undefined, { timeoutMs: 2_592_010_000 });
      const isSettled = trackSettlement(requestPromise);

      await vi.advanceTimersByTimeAsync(1);

      expect(isSettled()).toBe(false);
      expect(getPendingCount(client)).toBe(1);

      client.stop();
      await expect(requestPromise).rejects.toThrow("gateway client stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clamps oversized default request timeouts before scheduling", async () => {
    vi.useFakeTimers();
    try {
      const { client } = createOpenGatewayClient(2_592_010_000);

      const requestPromise = client.request("status");
      const isSettled = trackSettlement(requestPromise);

      await vi.advanceTimersByTimeAsync(1);

      expect(isSettled()).toBe(false);
      expect(getPendingCount(client)).toBe(1);

      client.stop();
      await expect(requestPromise).rejects.toThrow("gateway client stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clamps oversized stopAndWait timeouts before scheduling", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({});
      const ws = {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
        terminate: vi.fn(),
      };
      (client as unknown as { ws: unknown }).ws = ws;
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const stopPromise = client.stopAndWait({ timeoutMs: Number.MAX_SAFE_INTEGER });

      await vi.advanceTimersByTimeAsync(1);
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);

      await vi.advanceTimersByTimeAsync(249);
      await expect(stopPromise).resolves.toBeUndefined();
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  test("rejects mismatched tls fingerprint", async () => {
    const key = [
      "-----BEGIN PRIVATE KEY-----", // pragma: allowlist secret
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDrur5CWp4psMMb",
      "DTPY1aN46HPDxRchGgh8XedNkrlc4z1KFiyLUsXpVIhuyoXq1fflpTDz7++pGEDJ",
      "Q5pEdChn3fuWgi7gC+pvd5VQ1eAX/7qVE72fhx14NxhaiZU3hCzXjG2SflTEEExk",
      "UkQTm0rdHSjgLVMhTM3Pqm6Kzfdgtm9ZyXwlAsorE/pvgbUxG3Q4xKNBGzbirZ+1",
      "EzPDwsjf3fitNtakZJkymu6Kg5lsUihQVXOP0U7f989FmevoTMvJmkvJzsoTRd7s",
      "XNSOjzOwJr8da8C4HkXi21md1yEccyW0iSh7tWvDrpWDAgW6RMuMHC0tW4bkpDGr",
      "FpbQOgzVAgMBAAECggEAIMhwf8Ve9CDVTWyNXpU9fgnj2aDOCeg3MGaVzaO/XCPt",
      "KOHDEaAyDnRXYgMP0zwtFNafo3klnSBWmDbq3CTEXseQHtsdfkKh+J0KmrqXxval",
      "YeikKSyvBEIzRJoYMqeS3eo1bddcXgT/Pr9zIL/qzivpPJ4JDttBzyTeaTbiNaR9",
      "KphGNueo+MTQMLreMqw5VAyJ44gy7Z/2TMiMEc/d95wfubcOSsrIfpOKnMvWd/rl",
      "vxIS33s95L7CjREkixskj5Yo5Wpt3Yf5b0Zi70YiEsCfAZUDrPW7YzMlylzmhMzm",
      "MARZKfN1Tmo74SGpxUrBury+iPwf1sYcRnsHR+zO8QKBgQD6ISQHRzPboZ3J/60+",
      "fRLETtrBa9WkvaH9c+woF7l47D4DIlvlv9D3N1KGkUmhMnp2jNKLIlalBNDxBdB+",
      "iwZP1kikGz4629Ch3/KF/VYscLTlAQNPE42jOo7Hj7VrdQx9zQrK9ZBLteXmSvOh",
      "bB3aXwXPF3HoTMt9gQ9thhXZJQKBgQDxQxUnQSw43dRlqYOHzPUEwnJkGkuW/qxn",
      "aRc8eopP5zUaebiDFmqhY36x2Wd+HnXrzufy2o4jkXkWTau8Ns+OLhnIG3PIU9L/",
      "LYzJMckGb75QYiK1YKMUUSQzlNCS8+TFVCTAvG2u2zCCk7oTIe8aT516BQNjWDjK",
      "gWo2f87N8QKBgHoVANO4kfwJxszXyMPuIeHEpwquyijNEap2EPaEldcKXz4CYB4j",
      "4Cc5TkM12F0gGRuRohWcnfOPBTgOYXPSATOoX+4RCe+KaCsJ9gIl4xBvtirrsqS+",
      "42ue4h9O6fpXt9AS6sii0FnTnzEmtgC8l1mE9X3dcJA0I0HPYytOvY0tAoGAAYJj",
      "7Xzw4+IvY/ttgTn9BmyY/ptTgbxSI8t6g7xYhStzH5lHWDqZrCzNLBuqFBXosvL2",
      "bISFgx9z3Hnb6y+EmOUc8C2LyeMMXOBSEygmk827KRGUGgJiwsvHKDN0Ipc4BSwD",
      "ltkW7pMceJSoA1qg/k8lMxA49zQkFtA8c97U0mECgYEAk2DDN78sRQI8RpSECJWy",
      "l1O1ikVUAYVeh5HdZkpt++ddfpo695Op9OeD2Eq27Y5EVj8Xl58GFxNk0egLUnYq",
      "YzSbjcNkR2SbVvuLaV1zlQKm6M5rfvhj4//YrzrrPUQda7Q4eR0as/3q91uzAO2O",
      "++pfnSCVCyp/TxSkhEDEawU=",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const cert = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUel0Lv05cjrViyI/H3tABBJxM7NgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDEyMDEyMjEzMloXDTI2MDEy
MTEyMjEzMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA67q+QlqeKbDDGw0z2NWjeOhzw8UXIRoIfF3nTZK5XOM9
ShYsi1LF6VSIbsqF6tX35aUw8+/vqRhAyUOaRHQoZ937loIu4Avqb3eVUNXgF/+6
lRO9n4cdeDcYWomVN4Qs14xtkn5UxBBMZFJEE5tK3R0o4C1TIUzNz6puis33YLZv
Wcl8JQLKKxP6b4G1MRt0OMSjQRs24q2ftRMzw8LI3934rTbWpGSZMpruioOZbFIo
UFVzj9FO3/fPRZnr6EzLyZpLyc7KE0Xe7FzUjo8zsCa/HWvAuB5F4ttZndchHHMl
tIkoe7Vrw66VgwIFukTLjBwtLVuG5KQxqxaW0DoM1QIDAQABo1MwUTAdBgNVHQ4E
FgQUwNdNkEQtd0n/aofzN7/EeYPPPbIwHwYDVR0jBBgwFoAUwNdNkEQtd0n/aofz
N7/EeYPPPbIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAnOnw
o8Az/bL0A6bGHTYra3L9ArIIljMajT6KDHxylR4LhliuVNAznnhP3UkcZbUdjqjp
MNOM0lej2pNioondtQdXUskZtqWy6+dLbTm1RYQh1lbCCZQ26o7o/oENzjPksLAb
jRM47DYxRweTyRWQ5t9wvg/xL0Yi1tWq4u4FCNZlBMgdwAEnXNwVWTzRR9RHwy20
lmUzM8uQ/p42bk4EvPEV4PI1h5G0khQ6x9CtkadCTDs/ZqoUaJMwZBIDSrdJJSLw
4Vh8Lqzia1CFB4um9J4S1Gm/VZMBjjeGGBJk7VSYn4ZmhPlbPM+6z39lpQGEG0x4
r1USnb+wUdA7Zoj/mQ==
-----END CERTIFICATE-----`;

    httpsServer = createHttpsServer({ key, cert });
    wss = new WebSocketServer({ server: httpsServer, maxPayload: 1024 * 1024 });
    const port = await new Promise<number>((resolve, reject) => {
      httpsServer?.once("error", reject);
      httpsServer?.listen(0, "127.0.0.1", () => {
        const address = httpsServer?.address();
        if (!address || typeof address === "string") {
          reject(new Error("https server address unavailable"));
          return;
        }
        resolve(address.port);
      });
    });

    let client: GatewayClient | null = null;
    const error = await new Promise<Error>((resolve) => {
      let settled = false;
      const finish = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(err);
      };
      const timeout = setTimeout(() => {
        client?.stop();
        finish(new Error("timeout waiting for tls error"));
      }, 2000);
      client = new GatewayClient({
        url: `wss://127.0.0.1:${port}`,
        connectChallengeTimeoutMs: 0,
        tlsFingerprint: "deadbeef",
        onConnectError: (err) => {
          clearTimeout(timeout);
          client?.stop();
          finish(err);
        },
        onClose: () => {
          clearTimeout(timeout);
          client?.stop();
          finish(new Error("closed without tls error"));
        },
      });
      client.start();
    });

    expect(String(error)).toContain("tls fingerprint mismatch");
  });
});
