import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { GatewayClient, GatewayClientOptions } from "../../src/gateway/client.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../src/gateway/minimal-gateway.test-helpers.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { createDeferred } from "./promise.js";

afterEach(() => {
  vi.doUnmock("../../src/gateway/client.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

async function withStatusPeer(
  mode: "connect failure" | "success" | "retry" | "deadline",
  body: (fixture: {
    instance: Awaited<ReturnType<typeof createOpenClawTestInstance>>;
    clients: Array<{ client: GatewayClient; stopJoined: boolean }>;
    firstStop: ReturnType<typeof createDeferred<void>>;
    secondClient: ReturnType<typeof createDeferred<void>>;
    releaseStop: ReturnType<typeof createDeferred<void>>;
    requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[];
  }) => Promise<void>,
) {
  const clients: Array<{ client: GatewayClient; stopJoined: boolean; stop: () => Promise<void> }> =
    [];
  const firstStop = createDeferred();
  const secondClient = createDeferred();
  const releaseStop = createDeferred();
  const stopping: Promise<void>[] = [];
  vi.doMock("../../src/gateway/client.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/gateway/client.js")>();
    class ObservedGatewayClient extends actual.GatewayClient {
      constructor(options: GatewayClientOptions) {
        super(options);
        const stop = this.stopAndWait.bind(this);
        const entry = { client: this, stopJoined: false, stop: () => stop() };
        clients.push(entry);
        if (clients.length === 2) {
          secondClient.resolve();
        }
        this.stopAndWait = (stopOptions) => {
          // The real stop runs first. Holding its returned promise proves that
          // the helper joins completion rather than merely invoking shutdown.
          const operation = (async () => {
            if (entry === clients[0]) {
              firstStop.resolve();
            }
            await stop(stopOptions);
            await releaseStop.promise;
            entry.stopJoined = true;
          })();
          stopping.push(operation);
          return operation;
        };
      }
    }
    return { ...actual, GatewayClient: ObservedGatewayClient };
  });
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[] = [];
  let connection = 0;
  wss.on("connection", (ws) => {
    const ordinal = ++connection;
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      requests.push(frame);
      if (!frame.id) {
        throw new Error("status request omitted id");
      }
      if (
        (frame.method === "connect" && mode === "connect failure") ||
        (frame.method === "node.list" && mode === "retry" && ordinal === 1)
      ) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "UNAVAILABLE", message: "synthetic status failure" },
          }),
        );
      } else if (frame.method === "connect") {
        sendMinimalGatewayResponse(ws, frame.id, buildMinimalGatewayHelloOkPayload());
      } else if (frame.method === "node.list") {
        sendMinimalGatewayResponse(ws, frame.id, {
          nodes:
            mode === "deadline"
              ? []
              : [{ nodeId: "synthetic-node", connected: true, paired: true }],
        });
      }
    });
  });
  let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
  try {
    await once(wss, "listening");
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("status peer did not bind");
    }
    instance = await createOpenClawTestInstance({ name: "status-acquisition", port: address.port });
    instance.state.applyEnv();
    await body({ instance, clients, firstStop, secondClient, releaseStop, requests });
  } finally {
    releaseStop.resolve();
    // Also stop clients the broken helper never adopted; bypass only our observer.
    await Promise.all(clients.map((entry) => entry.stop()));
    await Promise.all(stopping);
    await closeMinimalGatewayServer(wss);
    await instance?.cleanup();
  }
}

describe("Gateway status helper acquisition ownership", () => {
  it("joins a failed status client's stop before rejecting acquisition", async () => {
    await withStatusPeer("connect failure", async (fixture) => {
      const { connectGatewayStatusClient } = await import("./gateway-e2e-harness.js");
      let settled = false;
      const result = connectGatewayStatusClient(fixture.instance)
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      try {
        await Promise.race([result, fixture.firstStop.promise]);
        await setImmediate();
        const settledBeforeStop = settled;
        fixture.releaseStop.resolve();
        const outcome = await result;
        expect(outcome.error).toMatchObject({ message: "synthetic status failure" });
        expect(fixture.requests[0]).toMatchObject({
          method: "connect",
          params: {
            client: {
              id: "cli",
              displayName: "status-status-acquisition",
              version: "1.0.0",
              platform: "test",
              mode: "cli",
            },
          },
        });
        expect(settledBeforeStop).toBe(false);
        expect(fixture.clients).toHaveLength(1);
        expect(fixture.clients[0]!.stopJoined).toBe(true);
      } finally {
        fixture.releaseStop.resolve();
        await result;
      }
    });
  });

  it.each(["success", "retry", "deadline"] as const)(
    "joins status polling cleanup before %s settlement or another acquisition",
    async (mode) => {
      await withStatusPeer(mode, async (fixture) => {
        const { waitForNodeStatus } = await import("./gateway-e2e-harness.js");
        let settled = false;
        const result = waitForNodeStatus(fixture.instance, "synthetic-node")
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          )
          .then((outcome) => {
            settled = true;
            return outcome;
          });
        try {
          await Promise.race([result, fixture.firstStop.promise, fixture.secondClient.promise]);
          await setImmediate();
          const settledBeforeStop = settled;
          const acquiredBeforeStop = fixture.clients.length;
          fixture.releaseStop.resolve();
          const outcome = await result;
          if (mode === "deadline") {
            expect(outcome.error).toMatchObject({
              message: "timeout waiting for node status for synthetic-node",
            });
          } else {
            expect(outcome.error).toBeUndefined();
          }
          expect(settledBeforeStop).toBe(false);
          expect(acquiredBeforeStop).toBe(1);
          expect(fixture.clients.every((entry) => entry.stopJoined)).toBe(true);
          expect(fixture.requests.some((frame) => frame.method === "node.list")).toBe(true);
        } finally {
          fixture.releaseStop.resolve();
          await result;
        }
      });
    },
  );
});
