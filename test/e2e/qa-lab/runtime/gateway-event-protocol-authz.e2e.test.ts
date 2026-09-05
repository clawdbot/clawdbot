import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createGatewayBroadcaster } from "../../../../src/gateway/server-broadcast.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../../../../src/gateway/server-constants.js";
import { GatewayClientRegistry } from "../../../../src/gateway/server/client-registry.js";
import type { GatewayWsClient } from "../../../../src/gateway/server/ws-types.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
} from "../../../../src/gateway/test-helpers.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../../src/infra/diagnostic-events.js";

installGatewayTestHooks({ scope: "suite" });

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  sent: Array<{ event?: string }>;
  send: ReturnType<typeof vi.fn>;
};

function makeRecordingSocket(): RecordingSocket {
  const sent: Array<{ event?: string }> = [];
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    sent,
    send: vi.fn((raw: string) => {
      sent.push(JSON.parse(raw) as { event?: string });
    }),
  };
}

function makeClient(
  connId: string,
  socket: RecordingSocket,
  role: "node" | "operator",
  scopes: string[],
): GatewayWsClient {
  return {
    connId,
    connect: { role, scopes } as GatewayWsClient["connect"],
    socket: socket as unknown as GatewayWsClient["socket"],
    usesSharedGatewayAuth: false,
  };
}

function sentEvents(socket: RecordingSocket): string[] {
  return socket.sent.flatMap((frame) => (frame.event ? [frame.event] : []));
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

afterEach(() => {
  resetDiagnosticEventsForTest();
});

describe("Gateway event and protocol authorization", () => {
  it("applies the production event recipient matrix and rejects unsafe plugin broadcasts", () => {
    const pairingSocket = makeRecordingSocket();
    const nodeSocket = makeRecordingSocket();
    const readSocket = makeRecordingSocket();
    const writeSocket = makeRecordingSocket();
    const adminSocket = makeRecordingSocket();
    const clients = new GatewayClientRegistry([
      makeClient("pairing", pairingSocket, "operator", ["operator.pairing"]),
      makeClient("node", nodeSocket, "node", ["operator.read"]),
      makeClient("read", readSocket, "operator", ["operator.read"]),
      makeClient("write", writeSocket, "operator", ["operator.write"]),
      makeClient("admin", adminSocket, "operator", ["operator.admin"]),
    ]);
    const { broadcast, broadcastPluginEvent } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "agent:main:main", message: "scoped" });
    broadcast("unknown.future.event", { hidden: true });
    broadcast("plugin.example.default", { revision: 1 });
    broadcastPluginEvent("plugin.example.read", { revision: 2 }, "operator.read");
    broadcastPluginEvent("plugin.example.write", { revision: 3 }, "operator.write");

    expect(sentEvents(pairingSocket)).toEqual([]);
    expect(sentEvents(nodeSocket)).toEqual([]);
    expect(sentEvents(readSocket)).toEqual(["chat", "plugin.example.read"]);
    expect(sentEvents(writeSocket)).toEqual([
      "chat",
      "plugin.example.default",
      "plugin.example.read",
      "plugin.example.write",
    ]);
    expect(sentEvents(adminSocket)).toEqual([
      "chat",
      "plugin.example.default",
      "plugin.example.read",
      "plugin.example.write",
    ]);

    const unsafe = broadcastPluginEvent as unknown as (
      event: string,
      payload: unknown,
      scope: string,
    ) => void;
    expect(() => unsafe("example.invalid", {}, "operator.read")).toThrow(
      "invalid plugin gateway event",
    );
    expect(() => unsafe("plugin.approval.requested", {}, "operator.read")).toThrow(
      "invalid plugin gateway event",
    );
    expect(() => unsafe("plugin.example.invalid", {}, "operator.approvals")).toThrow(
      "invalid plugin gateway event scope",
    );
  });

  it.each([
    ["malformed request frame", JSON.stringify({ unexpected: true }), "invalid request frame"],
    [
      "non-connect first request",
      JSON.stringify({ type: "req", id: "health-before-connect", method: "health" }),
      "first request must be connect",
    ],
  ])("closes a %s with policy code 1008", async (_name, frame, expectedReason) => {
    const harness = await createGatewaySuiteHarness({
      serverOptions: { auth: { mode: "none" } },
    });
    try {
      const ws = await harness.openWs();
      const closed = waitForClose(ws);
      const response = frame.includes("health-before-connect")
        ? onceMessage(ws, (message) => message.id === "health-before-connect")
        : undefined;

      ws.send(frame);

      if (response) {
        await expect(response).resolves.toMatchObject({
          type: "res",
          id: "health-before-connect",
          ok: false,
        });
      }
      await expect(closed).resolves.toMatchObject({
        code: 1008,
        reason: expect.stringContaining(expectedReason),
      });
    } finally {
      await harness.close();
    }
  });

  it("closes oversized pre-auth frames with 1009 and emits only redacted diagnostics", async () => {
    resetDiagnosticEventsForTest();
    const events: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onDiagnosticEvent((event) => events.push(event));
    const harness = await createGatewaySuiteHarness({
      serverOptions: { auth: { mode: "none" } },
    });
    const secretMarker = "sensitive-preauth-marker";
    try {
      const ws = await harness.openWs();
      const closed = waitForClose(ws);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "oversized-connect",
          method: "connect",
          params: {
            pathEnv: `${secretMarker}${"x".repeat(MAX_PREAUTH_PAYLOAD_BYTES + 1024)}`,
          },
        }),
      );

      await expect(closed).resolves.toMatchObject({ code: 1009 });
      const event = events.find((candidate) => candidate.type === "payload.large");
      expect(event).toMatchObject({
        type: "payload.large",
        action: "rejected",
        surface: "gateway.ws.preauth",
        limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
        reason: "preauth_frame_limit",
      });
      expect(JSON.stringify(event)).not.toContain(secretMarker);
      expect(event).not.toHaveProperty("payload");
    } finally {
      stopDiagnostics();
      await harness.close();
    }
  });
});
