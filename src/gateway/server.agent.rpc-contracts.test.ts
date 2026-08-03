// Real Gateway WebSocket proof for agent delivery fallback, response ordering, and idempotency.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { createDeferred } from "../shared/deferred.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { agentCommand, installGatewayTestHooks, onceMessage } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type AgentResponse = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: {
    runId?: string;
    status?: string;
  };
};

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

beforeEach(() => {
  vi.mocked(agentCommand).mockReset();
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
  test("downgrades ambiguous delivery and replays one ordered run across reconnect", async () => {
    const runCompletion = createDeferred();
    vi.mocked(agentCommand).mockImplementationOnce(async () => {
      await runCompletion.promise;
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
    await vi.waitFor(() => expect(agentCommand).toHaveBeenCalledTimes(1));
    expect(vi.mocked(agentCommand).mock.calls[0]?.[0]).toMatchObject({
      runId: idempotencyKey,
      channel: "webchat",
      messageChannel: "webchat",
      deliver: false,
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
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      second.ws.close();
    }
  });
});
