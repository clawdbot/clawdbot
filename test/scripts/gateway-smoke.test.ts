// Gateway Smoke tests cover gateway smoke script behavior.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { runGatewaySmoke } from "../../scripts/dev/gateway-smoke.js";

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    wss?.close(() => resolve());
    if (!wss) {
      resolve();
    }
  });
  wss = undefined;

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    if (!server) {
      resolve();
    }
  });
  server = undefined;
});

describe("gateway-smoke", () => {
  function healthResponse() {
    return {
      ok: true,
      payload: {
        agents: [],
        channelOrder: [],
        channels: {},
        defaultAgentId: "codex",
        durationMs: 3,
        ok: true,
        sessions: { count: 0, path: "/state/sessions", recent: [] },
        ts: Date.now(),
      },
    };
  }

  function connectHelloResponse(scopes: string[] = []) {
    return {
      ok: true,
      payload: {
        auth: { role: "operator", scopes },
        features: { events: [], methods: ["health"] },
        policy: {
          maxBufferedBytes: 1024 * 1024,
          maxPayload: 256 * 1024,
          tickIntervalMs: 1000,
        },
        protocol: 1,
        server: { connId: "test-conn", version: "dev" },
        snapshot: {},
        type: "hello-ok",
      },
    };
  }

  async function listenGatewaySmokeServer() {
    const requests: Array<{ method: string; params?: unknown; timeout?: number }> = [];
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as {
          id: string;
          method: string;
          params?: unknown;
          type: string;
        };
        requests.push({ method: frame.method, params: frame.params });
        if (frame.method === "connect") {
          ws.send(JSON.stringify({ id: frame.id, type: "res", ...connectHelloResponse() }));
          return;
        }
        if (frame.method === "health") {
          ws.send(JSON.stringify({ id: frame.id, type: "res", ...healthResponse() }));
          return;
        }
        if (frame.method === "chat.history") {
          ws.send(
            JSON.stringify({
              error: "missing scope: operator.read",
              id: frame.id,
              ok: false,
              type: "res",
            }),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            error: `unexpected method ${frame.method}`,
            id: frame.id,
            ok: false,
            type: "res",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test gateway smoke server did not get a TCP address");
    }
    return { requests, url: `ws://127.0.0.1:${address.port}` };
  }

  function createSmokeDeps(
    responses: Record<string, { error?: string; ok: boolean } & Record<string, unknown>>,
    calls: Array<{ method: string; timeout?: number }> = [],
  ) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let closed = 0;

    return {
      calls,
      get closed() {
        return closed;
      },
      stderr,
      stdout,
      deps: {
        createClient: () =>
          ({
            close: () => {
              closed += 1;
            },
            request: async (method: string, _params?: unknown, timeout?: number) => {
              calls.push({ method, timeout });
              const response = responses[method];
              return {
                id: method,
                ...response,
                ok: response?.ok ?? false,
                error: response?.error,
                type: "res",
              };
            },
            waitOpen: async () => {},
          }) as never,
        stderr: (message: string) => {
          stderr.push(message);
        },
        stdout: (message: string) => {
          stdout.push(message);
        },
      },
    };
  }

  it("passes against a loopback gateway websocket using the real client", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const loopback = await listenGatewaySmokeServer();

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: loopback.url },
      {
        stderr: (message) => {
          stderr.push(message);
        },
        stdout: (message) => {
          stdout.push(message);
        },
      },
    );

    expect(code).toBe(0);
    expect(loopback.requests.map((request) => request.method)).toEqual(["connect", "health"]);
    expect(loopback.requests[0]?.params).toMatchObject({
      auth: { token: "secret-token" },
      client: { id: "openclaw-ios" },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    expect(stdout).toEqual(["ok: connected + health"]);
    expect(stderr).toEqual([]);
  });

  it("closes the websocket client when connect fails", async () => {
    const stderr: string[] = [];
    const methods: string[] = [];
    let closed = 0;

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      {
        createClient: () =>
          ({
            close: () => {
              closed += 1;
            },
            request: async (method: string) => {
              methods.push(method);
              return { error: "bad token", id: "connect", ok: false, type: "res" };
            },
            waitOpen: async () => {},
          }) as never,
        stderr: (message) => {
          stderr.push(message);
        },
        stdout: () => {},
      },
    );

    expect(code).toBe(2);
    expect(closed).toBe(1);
    expect(methods).toEqual(["connect"]);
    expect(stderr).toEqual(["connect failed: bad token"]);
  });

  it("requires connect and health in order", async () => {
    const fake = createSmokeDeps({
      connect: connectHelloResponse(),
      health: healthResponse(),
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(0);
    expect(fake.closed).toBe(1);
    expect(fake.calls).toEqual([
      { method: "connect", timeout: undefined },
      { method: "health", timeout: undefined },
    ]);
    expect(fake.stdout).toEqual(["ok: connected + health"]);
    expect(fake.stderr).toEqual([]);
  });

  it("fails when connect success is missing hello evidence", async () => {
    const fake = createSmokeDeps({
      connect: { ok: true },
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(2);
    expect(fake.closed).toBe(1);
    expect(fake.calls).toEqual([{ method: "connect", timeout: undefined }]);
    expect(fake.stdout).toEqual([]);
    expect(fake.stderr).toEqual(["connect failed: missing hello-ok payload"]);
  });

  it("fails when the unpaired iOS-shaped connect keeps operator scopes", async () => {
    const fake = createSmokeDeps({
      connect: connectHelloResponse(["operator.read"]),
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(2);
    expect(fake.closed).toBe(1);
    expect(fake.calls).toEqual([{ method: "connect", timeout: undefined }]);
    expect(fake.stderr).toEqual([
      "connect failed: unpaired iOS smoke unexpectedly received operator scopes",
    ]);
  });

  it("fails after connect when health is unavailable", async () => {
    const fake = createSmokeDeps({
      connect: connectHelloResponse(),
      health: { ok: false, error: "not healthy" },
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(3);
    expect(fake.closed).toBe(1);
    expect(fake.calls.map((call) => call.method)).toEqual(["connect", "health"]);
    expect(fake.stderr).toEqual(["health failed: not healthy"]);
  });

  it("fails when health success is missing summary evidence", async () => {
    const fake = createSmokeDeps({
      connect: connectHelloResponse(),
      health: { ok: true },
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(3);
    expect(fake.closed).toBe(1);
    expect(fake.calls.map((call) => call.method)).toEqual(["connect", "health"]);
    expect(fake.stderr).toEqual(["health failed: missing health summary payload"]);
  });

  it("does not call scoped chat history for an unpaired iOS-shaped client", async () => {
    const fake = createSmokeDeps({
      connect: connectHelloResponse(),
      health: healthResponse(),
      "chat.history": { ok: false, error: "session store unavailable" },
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(0);
    expect(fake.closed).toBe(1);
    expect(fake.calls).toEqual([
      { method: "connect", timeout: undefined },
      { method: "health", timeout: undefined },
    ]);
    expect(fake.stderr).toEqual([]);
  });
});
