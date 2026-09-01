import { createServer } from "node:http";
import type { Context, Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

const model = {
  id: "scripted-model",
  name: "Scripted Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
} satisfies Model<"openai-responses">;

const tool = {
  name: "record_value",
  description: "Record the supplied value.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
};

function responseEvents(first: boolean) {
  const item = first
    ? {
        type: "function_call",
        id: "fc_number",
        call_id: "call_number",
        name: tool.name,
        arguments: '{"n":9007199254740993}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_done",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "recorded", annotations: [] }],
      };
  return [
    ...(first
      ? [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: '{"n":9007199254740993}',
          },
          { type: "response.output_item.done", output_index: 0, item },
        ]
      : []),
    {
      type: "response.completed",
      response: {
        id: first ? "resp_number" : "resp_done",
        status: "completed",
        output: [item],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
}

it.each([
  ["sse", "none"],
  ["sse", "response-value"],
  ["sse", "sent-type"],
  ["websocket-cached", "none"],
  ["websocket-cached", "response-value"],
  ["websocket-cached", "sent-type"],
] as const)(
  "preserves real %s continuation with edited arguments=%s",
  async (transport, edited) => {
    const requests: Array<Record<string, unknown>> = [];
    const eventsForRequest = (body: string) => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      return responseEvents(requests.length === 1);
    };
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of eventsForRequest(body)) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      });
    });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => {
      socket.on("message", (body) => {
        if (!Buffer.isBuffer(body)) {
          throw new Error("Expected a Buffer from the WebSocket server");
        }
        for (const event of eventsForRequest(body.toString("utf8"))) {
          socket.send(JSON.stringify(event));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP address");
    }
    // The replacement calls this original method with the active SDK client as `this`.
    // oxlint-disable-next-line typescript/unbound-method
    const buildURL = OpenAI.prototype.buildURL;
    // Route only the network destination; native eligibility, the SDK, and all request bytes stay real.
    vi.spyOn(OpenAI.prototype, "buildURL").mockImplementation(
      function (this: OpenAI, path, query, baseURL) {
        const url = new URL(buildURL.call(this, path, query, baseURL));
        expect(url.origin).toBe("https://api.openai.com");
        expect(url.pathname).toBe("/v1/responses");
        url.protocol = "http:";
        url.hostname = "127.0.0.1";
        url.port = String(address.port);
        return url.href;
      },
    );
    const run = async (messages: Context["messages"]) => {
      const stream = await createOpenAIResponsesTransportStreamFn()(
        model,
        { messages, tools: [tool] },
        {
          apiKey: "synthetic-continuation-key",
          sessionId: `wire-${transport}-${edited}`,
          transport,
          onPayload: (payload) => ({ ...(payload as Record<string, unknown>), store: true }),
        },
      );
      return stream.result();
    };
    try {
      const user = { role: "user" as const, content: "Record 9007199254740993.", timestamp: 1 };
      const first = await run([user]);
      expect(first.stopReason).toBe("toolUse");
      const call = first.content.find((block) => block.type === "toolCall");
      expect(call?.arguments).toEqual({ n: "9007199254740993" });
      if (!call) {
        throw new Error("Expected a completed tool call");
      }
      const replay = structuredClone(first);
      const editedValue = edited === "sent-type" ? 9007199254740992 : "9007199254740992";
      if (edited !== "none") {
        replay.content = [{ ...call, arguments: { n: editedValue } }];
      }
      const result = {
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "ok" }],
        isError: false,
        timestamp: 2,
      };
      const second = await run([user, replay, result]);
      expect(second.stopReason).toBe("stop");
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.type)).toEqual(
        transport === "websocket-cached"
          ? ["response.create", "response.create"]
          : [undefined, undefined],
      );
      if (edited !== "none") {
        expect(requests[1]).not.toHaveProperty("previous_response_id");
        expect(requests[1]?.input).toContainEqual(
          expect.objectContaining({
            type: "function_call",
            arguments: JSON.stringify({ n: editedValue }),
          }),
        );
      } else {
        expect(requests[1]).toMatchObject({
          previous_response_id: "resp_number",
          input: [{ type: "function_call_output", call_id: "call_number", output: "ok" }],
        });
      }
      expect(first.content.find((block) => block.type === "toolCall")?.arguments).toEqual({
        n: "9007199254740993",
      });
      if (edited === "sent-type") {
        const changedReplay = {
          ...replay,
          content: [{ ...call, arguments: { n: "9007199254740992" } }],
        };
        const third = await run([
          user,
          changedReplay,
          result,
          second,
          { role: "user", content: "Continue.", timestamp: 3 },
        ]);
        expect(third.stopReason).toBe("stop");
        expect(requests).toHaveLength(3);
        expect(requests[2]?.type).toBe(
          transport === "websocket-cached" ? "response.create" : undefined,
        );
        expect(requests[2]).not.toHaveProperty("previous_response_id");
        expect(requests[2]?.input).toHaveLength(5);
        expect(requests[2]?.input).toContainEqual(
          expect.objectContaining({ type: "function_call", arguments: '{"n":"9007199254740992"}' }),
        );
      }
    } finally {
      cleanupSessionResources();
      vi.restoreAllMocks();
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        sockets.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  },
);
