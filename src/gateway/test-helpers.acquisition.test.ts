import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
} from "./minimal-gateway.test-helpers.js";

afterEach(() => {
  vi.doUnmock("ws");
  vi.resetModules();
});

type PeerBehavior =
  | "hold upgrade"
  | "reject upgrade"
  | "no challenge"
  | "no response"
  | "reject auth"
  | "transport error"
  | "upgrade then transport error"
  | "hello then transport error"
  | "reply";

async function withAcquisitionPeer(
  behavior: PeerBehavior,
  body: (peer: {
    port: number;
    clients: WebSocket[];
    closed: Set<WebSocket>;
    errors: Error[];
    unownedErrors: Error[];
    requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[];
  }) => Promise<void>,
) {
  const clients: WebSocket[] = [];
  const closed = new Set<WebSocket>();
  const errors: Error[] = [];
  const unownedErrors: Error[] = [];
  // Observe the real dependency; keep otherwise-unhandled errors local to this case.
  // Counting the remaining listeners makes a removed owner handler observable.
  vi.doMock("ws", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ws")>();
    class ObservedWebSocket extends actual.WebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        clients.push(this);
        this.once("close", () => closed.add(this));
        this.on("error", (error) => {
          errors.push(error);
          if (this.listenerCount("error") === 1) {
            unownedErrors.push(error);
          }
        });
      }
    }
    return { ...actual, default: ObservedWebSocket, WebSocket: ObservedWebSocket };
  });
  const sockets = new Set<Socket>();
  const requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (behavior === "hold upgrade") {
      return;
    }
    if (behavior === "reject upgrade") {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    if (behavior === "upgrade then transport error") {
      socket.cork();
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (behavior === "upgrade then transport error") {
        // Batch the native HTTP upgrade and invalid frame in one writev.
        socket.write(Buffer.from([0x83, 0x00]));
        socket.uncork();
        return;
      }
      if (behavior !== "no challenge") {
        sendMinimalGatewayConnectChallenge(ws);
      }
      ws.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        requests.push(frame);
        if (
          frame.method === "connect" &&
          (behavior === "transport error" || behavior === "hello then transport error")
        ) {
          socket.cork();
          if (behavior === "hello then transport error") {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: { type: "hello-ok" },
              }),
            );
          }
          // A coalesced hello and invalid opcode must not become a successful acquisition.
          socket.write(Buffer.from([0x83, 0x00]));
          socket.uncork();
          return;
        }
        if (frame.method === "connect" && behavior !== "no response") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: behavior !== "reject auth",
              ...(behavior === "reject auth"
                ? { error: { code: "UNAUTHORIZED", message: "synthetic auth rejection" } }
                : { payload: { type: "hello-ok" } }),
            }),
          );
        }
      });
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("acquisition peer did not bind");
    }
    await body({ port: address.port, clients, closed, errors, unownedErrors, requests });
  } finally {
    // Assertions run before this safety net: the broken helper must not leak into
    // another case, including when it rejects with a still-CONNECTING socket.
    const clientClosures = clients.map(async (client) => {
      if (client.readyState !== WebSocket.CLOSED) {
        const closure = new Promise<void>((resolve) => {
          client.once("close", () => resolve());
        });
        client.terminate();
        await closure;
      }
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(clientClosures);
    await closeMinimalGatewayServer(wss);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe("raw Gateway helper acquisition ownership", () => {
  it.each([
    { helper: "tracked", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "tracked", behavior: "reject upgrade", error: "Unexpected server response: 503" },
    { helper: "tracked", behavior: "upgrade then transport error", error: "invalid opcode 3" },
    { helper: "shared auth", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "shared auth", behavior: "no challenge", error: "missing connect.challenge nonce" },
    { helper: "shared auth", behavior: "reject auth", error: "synthetic auth rejection" },
    { helper: "shared auth", behavior: "no response", error: "timeout" },
    { helper: "shared auth", behavior: "transport error", error: "invalid opcode 3" },
    { helper: "shared auth", behavior: "hello then transport error", error: "invalid opcode 3" },
    {
      helper: "device request",
      behavior: "no challenge",
      error: "timeout waiting for connect challenge",
    },
    { helper: "device request", behavior: "no response", error: "timeout" },
  ] as const)("$helper owns cleanup after $behavior", async ({ helper, behavior, error }) => {
    await withOpenClawTestState({ label: "raw-acquisition" }, async () => {
      await withAcquisitionPeer(behavior, async (peer) => {
        const { openTrackedWs } = await import("./device-authz.test-helpers.js");
        const { openAuthenticatedGatewayWs } = await import("./shared-auth.test-helpers.js");
        const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
        const acquisition =
          helper === "tracked"
            ? openTrackedWs(peer.port, { "x-acquisition-test": "tracked" })
            : helper === "shared auth"
              ? openAuthenticatedGatewayWs(peer.port, "synthetic-token")
              : connectDeviceAuthReq({
                  url: `ws://127.0.0.1:${peer.port}`,
                  token: "synthetic-token",
                });
        // Observe rejection immediately; none of these rows has an unbounded open wait.
        const failure: unknown = await acquisition.then(
          () => undefined,
          (reason: unknown) => reason,
        );
        if (
          behavior === "upgrade then transport error" ||
          behavior === "hello then transport error"
        ) {
          expect(peer.errors[0], "native error must precede acquisition settlement").toMatchObject({
            code: "WS_ERR_INVALID_OPCODE",
          });
          expect(failure).toBe(peer.errors[0]);
        }
        expect(peer.unownedErrors).toEqual([]);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({ message: expect.stringContaining(error) });
        if (behavior === "no response" || behavior === "reject auth") {
          expect(peer.requests).toHaveLength(1);
          expect(peer.requests[0]).toMatchObject({
            method: "connect",
            params: { auth: { token: "synthetic-token" } },
          });
        }
        expect(peer.clients).toHaveLength(1);
        const client = peer.clients[0]!;
        expect(client.readyState).toBe(WebSocket.CLOSED);
        expect(peer.closed.has(client)).toBe(true);
        expect(client.listenerCount("open")).toBe(0);
      });
    });
  });

  it("joins the one-shot device socket close before returning its response", async () => {
    await withOpenClawTestState({ label: "device-acquisition-response" }, async () => {
      await withAcquisitionPeer("reply", async (peer) => {
        const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
        const response = await connectDeviceAuthReq({
          url: `ws://127.0.0.1:${peer.port}`,
          token: "synthetic-token",
        });
        expect(response).toMatchObject({ type: "res", id: "c1", ok: true });
        expect(peer.requests).toHaveLength(1);
        expect(peer.requests[0]).toMatchObject({
          params: { auth: { token: "synthetic-token" }, device: { nonce: "test-nonce" } },
        });
        expect(peer.clients).toHaveLength(1);
        expect(peer.closed.has(peer.clients[0]!)).toBe(true);
        expect(peer.clients[0]!.readyState).toBe(WebSocket.CLOSED);
      });
    });
  });
});
