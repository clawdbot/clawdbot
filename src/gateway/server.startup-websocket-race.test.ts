import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

type StartGatewayServer = typeof import("./test-helpers.js").startGatewayServer;
type GatewayServerForTest = Awaited<ReturnType<StartGatewayServer>>;

installGatewayTestHooks({ scope: "suite" });

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
    const registry = createEmptyPluginRegistry();
    const runtimeState = await createGatewayRuntimeState({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 0,
      controlUiEnabled: false,
      controlUiBasePath: "/",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      resolvedAuth: {} as never,
      getResolvedAuth: () => ({}) as never,
      hooksConfig: () => null,
      getHookClientIpConfig: () => ({}) as never,
      pluginRegistry: registry,
      deps: {} as never,
      log: { info: () => {}, warn: () => {} },
      logHooks: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      logPlugins: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });
    try {
      expect(runtimeState.httpBindHosts).toEqual([]);
      expect(runtimeState.httpServer.listenerCount("upgrade")).toBeGreaterThan(0);
    } finally {
      runtimeState.releasePluginRouteRegistry();
      runtimeState.wss.close();
    }
  });

  it("accepts an immediate websocket connection once startup resolves", async () => {
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: GatewayServerForTest | undefined;
    let client: WebSocket | undefined;
    try {
      const port = await getFreePort();
      server = await startGatewayServer(port, {
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
});
