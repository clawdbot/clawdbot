import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type RealtimeOutcome = {
  errors: string[];
  transcripts: Array<{ speaker: string; text: string; final: boolean }>;
  tools: Array<{ itemId: string; callId: string; name: string; args: unknown }>;
};

async function captureRealtimeOutcome(
  eventInput: Record<string, unknown> | Record<string, unknown>[],
): Promise<RealtimeOutcome> {
  const events = Array.isArray(eventInput) ? eventInput : [eventInput];
  const outcome: RealtimeOutcome = { errors: [], transcripts: [], tools: [] };
  let markServerEventHandled: () => void = () => {};
  const serverEventHandled = new Promise<void>((resolve) => {
    markServerEventHandled = resolve;
  });
  const server = createServer();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("message", (message) => {
        if (JSON.parse(Buffer.from(message as Buffer).toString("utf8")).type !== "session.update") {
          return;
        }
        ws.send(JSON.stringify({ type: "session.updated" }));
        ws.send(JSON.stringify({ type: "response.created", response: { id: "response_1" } }));
        for (const event of events) {
          ws.send(JSON.stringify(event));
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const bridge = buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "fixture-value", baseUrl: `http://127.0.0.1:${port}/v1` },
    onAudio() {},
    onClearAudio() {},
    onError: (error) => outcome.errors.push(error.message),
    onTranscript: (speaker, text, final) => outcome.transcripts.push({ speaker, text, final }),
    onToolCall: (tool) => outcome.tools.push(tool),
    onEvent: (observed) => {
      if (observed.direction === "server" && observed.type === events.at(-1)?.type) {
        markServerEventHandled();
      }
    },
  });

  try {
    await bridge.connect();
    await serverEventHandled;
    return outcome;
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
  call_id: "call_tool",
  name: "lookup_weather",
  arguments: JSON.stringify({ city: "Paris" }),
};
const expectedTool = {
  itemId: "item_tool",
  callId: "call_tool",
  name: "lookup_weather",
  args: { city: "Paris" },
};

describe("xAI realtime terminal event ownership", () => {
  it.each([
    {
      name: "preserves assistant transcripts carried only by terminal output",
      event: {
        type: "response.done",
        response: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_audio", transcript: "terminal answer" }],
            },
          ],
        },
      },
      expected: {
        errors: [],
        transcripts: [{ speaker: "assistant", text: "terminal answer", final: true }],
        tools: [],
      },
    },
    {
      name: "surfaces failed responses with provider error details",
      event: {
        type: "response.done",
        response: { status: "failed", status_details: { error: { code: "rate_limit_exceeded" } } },
      },
      expected: { errors: ["rate_limit_exceeded"], transcripts: [], tools: [] },
    },
    {
      name: "surfaces incomplete responses with their authoritative reason",
      event: {
        type: "response.done",
        response: { status: "incomplete", status_details: { reason: "max_output_tokens" } },
      },
      expected: {
        errors: ["xAI realtime voice response incomplete: max_output_tokens"],
        transcripts: [],
        tools: [],
      },
    },
    {
      name: "does not mistake intentional cancellation for a provider failure",
      event: {
        type: "response.done",
        response: { status: "cancelled", status_details: { reason: "client_cancelled" } },
      },
      expected: { errors: [], transcripts: [], tools: [] },
    },
    {
      name: "ignores output-item events and waits for canonical terminal output",
      event: { type: "response.output_item.done", item: completedTool },
      expected: { errors: [], transcripts: [], tools: [] },
    },
    {
      name: "retains immediate completed replay delivery for resumed conversations",
      event: { type: "conversation.item.created", item: completedTool },
      expected: { errors: [], transcripts: [], tools: [expectedTool] },
    },
    {
      name: "retains immediate authoritative function-call argument completion",
      event: {
        type: "response.function_call_arguments.done",
        item_id: completedTool.id,
        call_id: completedTool.call_id,
        name: completedTool.name,
        arguments: completedTool.arguments,
      },
      expected: { errors: [], transcripts: [], tools: [expectedTool] },
    },
    {
      name: "preserves required streamed-call timing when the response later fails",
      event: [
        {
          type: "response.function_call_arguments.done",
          item_id: completedTool.id,
          call_id: completedTool.call_id,
          name: completedTool.name,
          arguments: completedTool.arguments,
        },
        { type: "response.done", response: { status: "failed", output: [] } },
      ],
      expected: {
        errors: ["xAI realtime voice response failed"],
        transcripts: [],
        tools: [expectedTool],
      },
    },
    {
      name: "does not dispatch incomplete replayed function-call items",
      event: {
        type: "conversation.item.created",
        item: { ...completedTool, status: "incomplete" },
      },
      expected: { errors: [], transcripts: [], tools: [] },
    },
    {
      name: "recovers completed tool calls from terminal response output",
      event: {
        type: "response.done",
        response: { status: "completed", output: [completedTool] },
      },
      expected: { errors: [], transcripts: [], tools: [expectedTool] },
    },
    {
      name: "deduplicates immediate tool delivery against terminal output",
      event: [
        {
          type: "response.function_call_arguments.done",
          item_id: completedTool.id,
          call_id: completedTool.call_id,
          name: completedTool.name,
          arguments: completedTool.arguments,
        },
        { type: "response.done", response: { status: "completed", output: [completedTool] } },
      ],
      expected: { errors: [], transcripts: [], tools: [expectedTool] },
    },
    ...["failed", "incomplete", "cancelled"].map((status) => ({
      name: `does not recover terminal-output tool calls from a ${status} response`,
      event: {
        type: "response.done",
        response: { status, output: [completedTool] },
      },
      expected: {
        errors: status === "cancelled" ? [] : [`xAI realtime voice response ${status}`],
        transcripts: [],
        tools: [],
      },
    })),
    {
      name: "does not dispatch incomplete items from a completed terminal response",
      event: {
        type: "response.done",
        response: { status: "completed", output: [{ ...completedTool, status: "incomplete" }] },
      },
      expected: { errors: [], transcripts: [], tools: [] },
    },
  ])("$name", async ({ event, expected }) => {
    expect(await captureRealtimeOutcome(event)).toEqual(expected);
  });
});
