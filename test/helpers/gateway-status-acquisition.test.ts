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

type PeerMode = "connect failure" | "success" | "retry" | "deadline";

async function withStatusPeer(
  mode: PeerMode,
  stopError: Error | undefined,
  body: (fixture: {
    instance: Awaited<ReturnType<typeof createOpenClawTestInstance>>;
    clients: Array<{ stopJoined: boolean }>;
    firstStop: ReturnType<typeof createDeferred<void>>;
    secondClient: ReturnType<typeof createDeferred<void>>;
    releaseStop: ReturnType<typeof createDeferred<void>>;
    requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[];
    errors: unknown[];
  }) => Promise<void>,
) {
  const clients: Array<{ stopJoined: boolean; stop: () => Promise<void> }> = [];
  const firstStop = createDeferred();
  const secondClient = createDeferred();
  const releaseStop = createDeferred();
  const stopping: Promise<void>[] = [];
  const errors: unknown[] = [];
  vi.doMock("../../src/gateway/client.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/gateway/client.js")>();
    class ObservedGatewayClient extends actual.GatewayClient {
      constructor(options: GatewayClientOptions) {
        super({
          ...options,
          onConnectError: (error) => {
            errors.push(error);
            options.onConnectError?.(error);
          },
        });
        const stop = this.stopAndWait.bind(this);
        const entry = { stopJoined: false, stop: () => stop() };
        clients.push(entry);
        if (clients.length === 2) {
          secondClient.resolve();
        }
        this.stopAndWait = (stopOptions) => {
          // Hold the real stop's completion, not its socket, to expose an unjoined owner.
          const operation = (async () => {
            if (entry === clients[0]) {
              firstStop.resolve();
            }
            await stop(stopOptions);
            await releaseStop.promise;
            if (stopError) {
              throw stopError;
            }
            entry.stopJoined = true;
          })();
          stopping.push(operation);
          return operation;
        };
        const request = this.request.bind(this);
        this.request = async <T>(...args: Parameters<GatewayClient["request"]>): Promise<T> => {
          try {
            return await request<T>(...args);
          } catch (error) {
            errors.push(error);
            throw error;
          }
        };
      }
    }
    return { ...actual, GatewayClient: ObservedGatewayClient };
  });
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 64 * 1024 });
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
    await body({ instance, clients, firstStop, secondClient, releaseStop, requests, errors });
  } finally {
    releaseStop.resolve();
    // Drain even clients the broken helper never adopted; bypass only the observer.
    await Promise.all(clients.map((entry) => entry.stop()));
    await Promise.allSettled(stopping);
    await closeMinimalGatewayServer(wss);
    await instance?.cleanup();
  }
}

describe("Gateway status helper acquisition ownership", () => {
  it.each(["connect failure", "success", "retry", "deadline"] as const)(
    "joins cleanup before %s settlement or another acquisition",
    async (mode) => {
      await withStatusPeer(mode, undefined, async (fixture) => {
        const { connectGatewayStatusClient, waitForNodeStatus } =
          await import("./gateway-e2e-harness.js");
        let settled = false;
        const operation =
          mode === "connect failure"
            ? connectGatewayStatusClient(fixture.instance)
            : waitForNodeStatus(fixture.instance, "synthetic-node");
        const result = operation
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
          if (mode === "connect failure") {
            expect(outcome.error).toBe(fixture.errors[0]);
            expect(outcome.error).toMatchObject({ message: "synthetic status failure" });
          } else if (mode === "deadline") {
            expect(outcome.error).toMatchObject({
              message: "timeout waiting for node status for synthetic-node",
            });
          } else {
            expect(outcome.error).toBeUndefined();
          }
          expect(settledBeforeStop).toBe(false);
          expect(acquiredBeforeStop).toBe(1);
          expect(fixture.clients).toHaveLength(mode === "retry" ? 2 : 1);
          expect(fixture.clients.every((entry) => entry.stopJoined)).toBe(true);
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
        } finally {
          fixture.releaseStop.resolve();
          await result;
        }
      });
    },
  );

  it.each(["connect failure", "success", "retry"] as const)(
    "surfaces cleanup failure after %s without acquiring another client",
    async (mode) => {
      const stopError = new Error("synthetic stop failure");
      await withStatusPeer(mode, stopError, async (fixture) => {
        const { waitForNodeStatus } = await import("./gateway-e2e-harness.js");
        fixture.releaseStop.resolve();
        const failure: unknown = await waitForNodeStatus(fixture.instance, "synthetic-node").then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(fixture.clients).toHaveLength(1);
        if (mode === "success") {
          expect(failure).toBe(stopError);
        } else {
          expect(failure).toBeInstanceOf(AggregateError);
          expect(failure).toMatchObject({ errors: [fixture.errors[0], stopError] });
          expect(fixture.errors[0]).toMatchObject({ message: "synthetic status failure" });
        }
      });
    },
  );
});
