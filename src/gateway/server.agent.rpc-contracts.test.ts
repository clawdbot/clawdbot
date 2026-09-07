import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
// Real Gateway WebSocket proof for agent delivery fallback, response ordering, and idempotency.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type AgentResponse = {
  type?: string;
  id?: string;
  ok?: boolean;
  error?: { message?: string };
  payload?: {
    runId?: string;
    status?: string;
    result?: {
      payloads?: Array<{ text?: string }>;
      deliveryStatus?: {
        requested?: boolean;
        attempted?: boolean;
        reason?: string;
      };
    };
  };
};

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

beforeEach(async () => {
  vi.mocked(agentCommandMock).mockReset();
  await prepareGatewayReplyRuntimeForTest();
});

afterAll(async () => {
  await harness.close();
});

function sendAgentRequest(params: {
  ws: WebSocket;
  id: string;
  idempotencyKey: string;
  message: string;
}): void {
  params.ws.send(
    JSON.stringify({
      type: "req",
      id: params.id,
      method: "agent",
      params: {
        message: params.message,
        sessionKey: "main",
        deliver: true,
        bestEffortDeliver: true,
        idempotencyKey: params.idempotencyKey,
      },
    }),
  );
}

describe("gateway agent RPC contracts", () => {
  test("preserves requested delivery status across ordered final response and replay", async () => {
    const runCompletion = createDeferred();
    vi.mocked(agentCommandMock).mockImplementationOnce(async () => {
      await runCompletion.promise;
      return {
        payloads: [{ text: "assistant reply" }],
        meta: { durationMs: 1 },
        deliverySucceeded: false,
        deliveryStatus: {
          requested: true,
          attempted: false,
          status: "failed",
          succeeded: false,
          error: true,
          reason: "channel_resolved_to_internal",
        },
      };
    });

    const idempotencyKey = "gateway-agent-rpc-contract";
    const first = await harness.openClient();
    const orderedResponses: AgentResponse[] = [];
    const recordResponse = (data: RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as AgentResponse;
      if (frame.type === "res" && frame.id === "agent-contract") {
        orderedResponses.push(frame);
      }
    };
    first.ws.on("message", recordResponse);
    const acceptedPromise = onceMessage<AgentResponse>(
      first.ws,
      (frame) =>
        frame.type === "res" &&
        frame.id === "agent-contract" &&
        frame.payload?.status === "accepted",
    );
    const terminalPromise = onceMessage<AgentResponse>(
      first.ws,
      (frame) =>
        frame.type === "res" &&
        frame.id === "agent-contract" &&
        frame.payload?.status !== "accepted",
    );

    sendAgentRequest({
      ws: first.ws,
      id: "agent-contract",
      idempotencyKey,
      message: "prove the gateway agent RPC contract",
    });

    await acceptedPromise;
    await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
    expect(vi.mocked(agentCommandMock).mock.calls[0]?.[0]).toMatchObject({
      runId: idempotencyKey,
      channel: "webchat",
      messageChannel: "webchat",
      deliver: true,
      bestEffortDeliver: true,
    });

    runCompletion.resolve();
    const terminal = await terminalPromise;
    first.ws.off("message", recordResponse);
    expect(orderedResponses.map((frame) => frame.payload?.status)).toEqual(["accepted", "ok"]);
    const accepted = orderedResponses[0];
    expect(accepted).toMatchObject({
      type: "res",
      id: "agent-contract",
      ok: true,
      payload: {
        runId: idempotencyKey,
        status: "accepted",
      },
    });
    expect(terminal).toMatchObject({
      type: "res",
      id: "agent-contract",
      ok: true,
      payload: {
        runId: idempotencyKey,
        status: "ok",
        result: {
          payloads: [{ text: "assistant reply" }],
          deliveryStatus: {
            requested: true,
            attempted: false,
            reason: "channel_resolved_to_internal",
          },
        },
      },
    });

    first.ws.close();
    await new Promise<void>((resolve) => {
      first.ws.once("close", () => resolve());
    });

    const second = await harness.openClient();
    try {
      const replayPromise = onceMessage<AgentResponse>(
        second.ws,
        (frame) => frame.type === "res" && frame.id === "agent-contract-replay",
      );
      sendAgentRequest({
        ws: second.ws,
        id: "agent-contract-replay",
        idempotencyKey,
        message: "this duplicate must not execute",
      });

      const replay = await replayPromise;
      expect(replay.payload).toEqual(terminal.payload);
      expect(replay.payload?.status).toBe("ok");
      expect(replay.payload?.result?.deliveryStatus).toMatchObject({
        requested: true,
        attempted: false,
        reason: "channel_resolved_to_internal",
      });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    } finally {
      second.ws.close();
    }
  });

  test("dispatches a run woken by a cron system event instead of rejecting the channel", async () => {
    vi.mocked(agentCommandMock).mockImplementationOnce(async () => ({
      payloads: [{ text: "child run started" }],
      meta: { durationMs: 1 },
    }));

    const client = await harness.openClient();
    try {
      const terminalPromise = onceMessage<AgentResponse>(
        client.ws,
        (frame) =>
          frame.type === "res" &&
          frame.id === "agent-cron-event" &&
          frame.payload?.status !== "accepted",
      );

      client.ws.send(
        JSON.stringify({
          type: "req",
          id: "agent-cron-event",
          method: "agent",
          params: {
            message: "spawn a child run from a cron system event",
            sessionKey: "main",
            channel: "cron-event",
            idempotencyKey: "gateway-agent-cron-event-channel",
          },
        }),
      );

      const terminal = await terminalPromise;
      expect(terminal.error?.message ?? null).toBeNull();
      expect(terminal.ok).toBe(true);
      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
    } finally {
      client.ws.close();
    }
  });
});
