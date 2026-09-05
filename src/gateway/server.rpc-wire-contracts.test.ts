// Real Gateway WebSocket proof for RPC envelopes, discovery, and event ordering.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type WireFrame = {
  type?: string;
  id?: string;
  ok?: boolean;
  event?: string;
  payload?: Record<string, unknown> | null;
  seq?: number;
};

type ConnectedWireClient = {
  ws: WebSocket;
  challenge: WireFrame;
  connectResponse: WireFrame;
};

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

afterAll(async () => {
  await harness.close();
});

async function openWireClient(): Promise<ConnectedWireClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`);
  trackConnectChallengeNonce(ws);
  const challengePromise = onceMessage<WireFrame>(
    ws,
    (frame) => frame.type === "event" && frame.event === "connect.challenge",
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const challenge = await challengePromise;
  const connectResponse = await connectReq(ws);
  return { ws, challenge, connectResponse };
}

function expectChallenge(frame: WireFrame): void {
  expect(frame).toMatchObject({
    type: "event",
    event: "connect.challenge",
    payload: {
      nonce: expect.any(String),
      ts: expect.any(Number),
    },
  });
  expect(frame).not.toHaveProperty("id");
}

function expectConnectResponse(frame: WireFrame): void {
  expect(frame).toMatchObject({
    type: "res",
    id: expect.any(String),
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: expect.any(Number),
      server: {
        version: expect.any(String),
        connId: expect.any(String),
      },
      features: {
        methods: expect.arrayContaining(["health", "agent"]),
        events: expect.arrayContaining(["connect.challenge", "heartbeat"]),
      },
    },
  });
}

describe("gateway RPC wire contracts", () => {
  test("publishes canonical envelopes, discovery catalogs, and ordered events", async () => {
    const clients = await Promise.all([openWireClient(), openWireClient()]);

    try {
      for (const client of clients) {
        expectChallenge(client.challenge);
        expectConnectResponse(client.connectResponse);
      }

      const healthResponsePromise = onceMessage<WireFrame>(
        clients[0].ws,
        (frame) => frame.type === "res" && frame.id === "wire-health",
      );
      clients[0].ws.send(
        JSON.stringify({
          type: "req",
          id: "wire-health",
          method: "health",
        }),
      );
      expect(await healthResponsePromise).toMatchObject({
        type: "res",
        id: "wire-health",
        ok: true,
        payload: expect.any(Object),
      });

      const firstHeartbeatPromises = clients.map((client) =>
        onceMessage<WireFrame>(
          client.ws,
          (frame) =>
            frame.type === "event" &&
            frame.event === "heartbeat" &&
            frame.payload?.status === "sent",
        ),
      );
      emitHeartbeatEvent({ status: "sent", to: "qa-wire", preview: "first" });
      const firstHeartbeats = await Promise.all(firstHeartbeatPromises);

      const secondHeartbeatPromises = clients.map((client) =>
        onceMessage<WireFrame>(
          client.ws,
          (frame) =>
            frame.type === "event" &&
            frame.event === "heartbeat" &&
            frame.payload?.status === "skipped",
        ),
      );
      emitHeartbeatEvent({ status: "skipped", reason: "qa-wire-ordering" });
      const secondHeartbeats = await Promise.all(secondHeartbeatPromises);

      for (const [index, first] of firstHeartbeats.entries()) {
        const second = secondHeartbeats[index];
        if (!second) {
          throw new Error(`missing second heartbeat for client ${index}`);
        }
        expect(first).toMatchObject({
          type: "event",
          event: "heartbeat",
          payload: { status: "sent" },
          seq: expect.any(Number),
        });
        expect(second).toMatchObject({
          type: "event",
          event: "heartbeat",
          payload: { status: "skipped" },
          seq: expect.any(Number),
        });
        expect(second.seq).toBeGreaterThan(first.seq ?? Number.NEGATIVE_INFINITY);
      }
    } finally {
      for (const client of clients) {
        client.ws.close();
      }
    }
  });
});
