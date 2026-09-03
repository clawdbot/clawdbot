import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceResponseOutcome } from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type CapturedOutcome = {
  clientEvents: string[];
  errors: string[];
  events: string[];
  outcomes: RealtimeVoiceResponseOutcome[];
  tools: Array<{ itemId: string; callId: string; name: string; args: unknown }>;
  connected: boolean;
};

async function capture(
  terminalEvent: Record<string, unknown>,
  options: { completeFollowup?: boolean; queueFollowup?: boolean; throwCallback?: boolean } = {},
): Promise<CapturedOutcome> {
  const captured: CapturedOutcome = {
    clientEvents: [],
    errors: [],
    events: [],
    outcomes: [],
    tools: [],
    connected: false,
  };
  const responseCreated = createDeferred<void>();
  const terminalProcessed = createDeferred<void>();
  const followupCreated = createDeferred<void>();
  const followupCompleted = createDeferred<void>();
  const server = createServer();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("message", (message) => {
        const event = JSON.parse(Buffer.from(message as Buffer).toString("utf8")) as {
          type?: string;
        };
        if (!event.type) {
          return;
        }
        captured.clientEvents.push(event.type);
        if (event.type === "session.update" && captured.clientEvents.length === 1) {
          ws.send(JSON.stringify({ type: "session.updated" }));
        }
        if (event.type === "response.create") {
          followupCreated.resolve();
          if (options.completeFollowup) {
            ws.send(JSON.stringify({ type: "response.created", response: { id: "response_2" } }));
            ws.send(
              JSON.stringify({
                type: "response.done",
                response: { id: "response_2", status: "completed", output: [] },
              }),
            );
          }
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "fixture-value", azureEndpoint: `http://127.0.0.1:${port}` },
    onAudio() {},
    onClearAudio() {},
    onError: (error) => captured.errors.push(error.message),
    onResponseDone: (outcome) => {
      captured.outcomes.push(outcome);
      captured.events.push(`outcome:${outcome.status}`);
      if (outcome.responseId === "response_2") {
        followupCompleted.resolve();
      }
      if (options.throwCallback && outcome.responseId === "response_1") {
        throw new Error("consumer callback failed");
      }
    },
    onToolCall: (tool) => {
      captured.tools.push(tool);
      captured.events.push(`tool:${tool.callId}`);
    },
    onEvent: (event) => {
      captured.events.push(`${event.direction}:${event.type}`);
      if (event.direction === "server" && event.type === "response.created") {
        responseCreated.resolve();
      }
      if (event.direction === "server" && event.type === terminalEvent.type) {
        queueMicrotask(terminalProcessed.resolve);
      }
    },
  });
  try {
    await bridge.connect();
    const socket = [...sockets][0];
    if (!socket) {
      throw new Error("expected a connected fixture socket");
    }
    socket.send(JSON.stringify({ type: "response.created", response: { id: "response_1" } }));
    await withTimeout(responseCreated.promise, 2_000, {
      message: "timed out waiting for response.created",
    });
    if (options.queueFollowup) {
      bridge.sendUserMessage?.("Continue after the terminal response.");
    }
    socket.send(JSON.stringify(terminalEvent));
    await withTimeout(terminalProcessed.promise, 2_000, {
      message: "timed out waiting for terminal response",
    });
    if (options.queueFollowup) {
      await withTimeout(followupCreated.promise, 2_000, {
        message: "timed out waiting for queued response.create",
      });
    }
    if (options.completeFollowup) {
      await withTimeout(followupCompleted.promise, 2_000, {
        message: "timed out waiting for completed follow-up",
      });
    }
    captured.connected = bridge.isConnected();
    return captured;
  } finally {
    bridge.close();
    for (const socket of sockets) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

const completedTool = {
  id: "item_tool",
  type: "function_call",
  status: "completed",
  call_id: "call_tool",
  name: "lookup_weather",
  arguments: JSON.stringify({ city: "Paris" }),
};

describe("OpenAI realtime terminal response ownership", () => {
  it.each([
    {
      response: { status: "completed", output: [] },
      expected: { responseId: "response_1", status: "completed" },
    },
    {
      response: {
        status: "cancelled",
        status_details: { reason: "client_cancelled" },
        output: [completedTool],
      },
      expected: { responseId: "response_1", status: "cancelled", reason: "client_cancelled" },
    },
    {
      response: {
        status: "failed",
        status_details: { error: { type: "server_error", code: "rate_limit_exceeded" } },
        output: [completedTool],
      },
      expected: {
        responseId: "response_1",
        status: "failed",
        error: { type: "server_error", code: "rate_limit_exceeded" },
        message: "OpenAI realtime voice response failed: rate_limit_exceeded",
      },
    },
    {
      response: {
        status: "incomplete",
        status_details: { reason: "max_output_tokens" },
        output: [completedTool],
      },
      expected: {
        responseId: "response_1",
        status: "incomplete",
        reason: "max_output_tokens",
        message: "OpenAI realtime voice response incomplete: max_output_tokens",
      },
    },
    {
      response: { output: [completedTool] },
      expected: {
        responseId: "response_1",
        status: "failed",
        reason: "invalid_response_status",
        error: { type: "invalid_response_status", message: "missing terminal status" },
        message: "OpenAI realtime voice response failed: missing terminal status",
      },
    },
    {
      response: { status: "in_progress", output: [completedTool] },
      expected: {
        responseId: "response_1",
        status: "failed",
        reason: "invalid_response_status",
        error: { type: "invalid_response_status", message: "invalid status in_progress" },
        message: "OpenAI realtime voice response failed: invalid status in_progress",
      },
    },
  ])(
    "normalizes $response.status without closing the reusable socket",
    async ({ response, expected }) => {
      const captured = await capture(
        { type: "response.done", response: { id: "response_1", ...response } },
        { queueFollowup: true },
      );

      expect(captured.errors).toEqual([]);
      expect(captured.outcomes).toEqual([expected]);
      expect(captured.tools).toEqual([]);
      expect(captured.clientEvents.filter((type) => type === "response.create")).toHaveLength(1);
      expect(captured.connected).toBe(true);
      expect(captured.events.indexOf(`outcome:${expected.status}`)).toBeLessThan(
        captured.events.indexOf("server:response.done"),
      );
    },
  );

  it("delivers completed tools before their response owner is retired", async () => {
    const captured = await capture({
      type: "response.done",
      response: { id: "response_1", status: "completed", output: [completedTool] },
    });

    expect(captured.tools).toEqual([
      {
        itemId: "item_tool",
        callId: "call_tool",
        name: "lookup_weather",
        args: { city: "Paris" },
      },
    ]);
    expect(captured.events.indexOf("tool:call_tool")).toBeLessThan(
      captured.events.indexOf("outcome:completed"),
    );
  });

  it("drains a queued follow-up when the terminal consumer throws", async () => {
    const captured = await capture(
      { type: "response.done", response: { id: "response_1", status: "failed", output: [] } },
      { completeFollowup: true, queueFollowup: true, throwCallback: true },
    );

    expect(captured.errors).toEqual([]);
    expect(captured.outcomes).toEqual([
      {
        responseId: "response_1",
        status: "failed",
        message: "OpenAI realtime voice response failed",
      },
      { responseId: "response_2", status: "completed" },
    ]);
    expect(captured.clientEvents.filter((type) => type === "response.create")).toHaveLength(1);
    expect(captured.connected).toBe(true);
  });
});
