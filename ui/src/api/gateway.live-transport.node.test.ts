/** @vitest-environment node */
// Control UI gateway tests cover the tick watchdog over a real WebSocket transport:
// a real server, a real socket, and real timers, so the recovery path is exercised
// end to end rather than through a stubbed socket.
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { GatewayBrowserClient } from "./gateway.ts";

const TICK_INTERVAL_MS = 200;
const clients = new Set<InstanceType<typeof GatewayBrowserClient>>();
const servers = new Set<GatewayHarness>();

type GatewayHarness = {
  url: string;
  connectionCount: () => number;
  clientCloses: () => { code: number; reason: string }[];
  close: () => Promise<void>;
};

/**
 * A real WebSocket server that speaks enough gateway protocol to bring a Control UI
 * client to hello-ok, then either goes silent or keeps ticking. Requests are never
 * answered, which is what a stalled gateway looks like from the browser's side.
 */
async function startGatewayHarness(params: { keepTicking: boolean }): Promise<GatewayHarness> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener address");
  }
  let connectionCount = 0;
  const clientCloses: { code: number; reason: string }[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();

  wss.on("connection", (socket: WsSocket) => {
    connectionCount += 1;
    socket.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-1" } }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { id?: string; method?: string };
      if (frame.method !== "connect") {
        return;
      }
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: PROTOCOL_VERSION,
            auth: { role: "operator", scopes: [] },
            policy: {
              maxPayload: 1024 * 1024,
              maxBufferedBytes: 1024 * 1024,
              tickIntervalMs: TICK_INTERVAL_MS,
            },
          },
        }),
      );
      if (!params.keepTicking) {
        return;
      }
      const timer = setInterval(
        () => {
          socket.send(JSON.stringify({ type: "event", event: "tick", payload: {} }));
        },
        Math.floor(TICK_INTERVAL_MS / 2),
      );
      timers.add(timer);
      socket.on("close", () => clearInterval(timer));
    });
    socket.on("close", (code, reason) => {
      clientCloses.push({ code, reason: String(reason) });
    });
  });

  const harness: GatewayHarness = {
    url: `ws://127.0.0.1:${address.port}`,
    connectionCount: () => connectionCount,
    clientCloses: () => clientCloses,
    close: async () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      for (const socket of wss.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  servers.add(harness);
  return harness;
}

async function connectClient(harness: GatewayHarness) {
  const client = new GatewayBrowserClient({ url: harness.url, token: "shared-auth-token" });
  clients.add(client);
  client.start();
  await waitFor(() => harness.connectionCount() > 0);
  // Let the challenge/connect exchange finish before the request is issued.
  await delay(TICK_INTERVAL_MS);
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await delay(20);
  }
}

afterEach(async () => {
  for (const client of clients) {
    client.stop();
  }
  clients.clear();
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe("GatewayBrowserClient over a real WebSocket", () => {
  it("rejects an unbounded request and reconnects when the transport goes silent", async () => {
    const harness = await startGatewayHarness({ keepTicking: false });
    const client = await connectClient(harness);

    // Control UI issues requests without a deadline, so the socket is the only liveness signal.
    const pending = client.request("mcp.app.callTool", { toolName: "slow-tool" });

    await expect(pending).rejects.toThrow(/tick timeout/);
    // The rejection is observed client-side first; the close frame lands a tick later.
    await waitFor(() => harness.clientCloses().length > 0);
    expect(harness.clientCloses()).toEqual([{ code: 4000, reason: "tick timeout" }]);
    // The existing reconnect supervisor takes over once the stale socket is gone.
    await waitFor(() => harness.connectionCount() > 1);
  }, 20_000);

  it("leaves the same request pending while the transport keeps ticking", async () => {
    const harness = await startGatewayHarness({ keepTicking: true });
    const client = await connectClient(harness);

    let settled = false;
    void client.request("mcp.app.callTool", { toolName: "slow-tool" }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await delay(TICK_INTERVAL_MS * 15);

    expect(settled).toBe(false);
    expect(harness.clientCloses()).toEqual([]);
    expect(harness.connectionCount()).toBe(1);
  }, 20_000);
});
