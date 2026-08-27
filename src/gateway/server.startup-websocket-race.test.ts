// Startup WebSocket race tests ensure upgrade handlers are attached before the
// gateway reports its listen step as ready.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { tryListenOnPort } from "../infra/ports-probe.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "./test-helpers.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

type StartGatewayServer = typeof import("./test-helpers.js").startTestGatewayServer;
type GatewayServerForTest = Awaited<ReturnType<StartGatewayServer>>;

installGatewayTestHooks({ scope: "suite" });

let loopbackAliasBindable = false;

beforeAll(async () => {
  try {
    await tryListenOnPort({ host: "127.0.0.2", port: 0, exclusive: true });
    loopbackAliasBindable = true;
  } catch {
    loopbackAliasBindable = false;
  }
});

async function connectWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return await new Promise<WebSocket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error("expected websocket connect to succeed immediately after startup"));
    }, 5_000);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", handleOpen);
      ws.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve(ws);
    };
    const handleError = (err: Error) => {
      cleanup();
      reject(err);
    };
    ws.once("open", handleOpen);
    ws.once("error", handleError);
  });
}

async function disconnectWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway startup websocket readiness", () => {
  it("attaches websocket upgrade handlers before exposing the listen step", async () => {
    const runtimeState = await createGatewayRuntimeStateForTest();
    try {
      expect(runtimeState.httpBindHosts).toEqual([]);
      expect(runtimeState.httpServer.listenerCount("upgrade")).toBeGreaterThan(0);
    } finally {
      runtimeState.wss.close();
    }
  });

  it("accepts an immediate websocket connection once startup resolves", async () => {
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: GatewayServerForTest | undefined;
    let client: WebSocket | undefined;
    try {
      const port = await getGatewayTestPort();
      server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
      });

      client = await connectWebSocket(`ws://127.0.0.1:${port}`);
    } finally {
      if (client) {
        await disconnectWebSocket(client);
      }
      if (server) {
        await server.close();
      }
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });

  it("serves a specific IPv4 bind and its required loopback alias", async ({ skip }) => {
    if (!loopbackAliasBindable) {
      skip("127.0.0.2 is not bindable on this host");
      return;
    }
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: GatewayServerForTest | undefined;
    const clients: WebSocket[] = [];
    try {
      const port = await getGatewayTestPort();
      server = await startTestGatewayServer(port, {
        host: "127.0.0.2",
        auth: { mode: "none" },
      });

      clients.push(
        await connectWebSocket(`ws://127.0.0.1:${port}`),
        await connectWebSocket(`ws://127.0.0.2:${port}`),
      );
    } finally {
      await Promise.all(clients.map(async (client) => await disconnectWebSocket(client)));
      if (server) {
        await server.close();
      }
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });

  it("releases the loopback alias when the selected bind fails", async () => {
    const port = await getGatewayTestPort();

    await expect(
      startTestGatewayServer(port, {
        bind: "lan",
        host: "192.0.2.1",
        auth: { mode: "token", token: "test-token" },
      }),
    ).rejects.toThrow("failed to bind gateway socket");

    await expect(
      tryListenOnPort({ host: "127.0.0.1", port, exclusive: true }),
    ).resolves.toBeUndefined();
  });
});
