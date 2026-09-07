import type { Context } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";

const tool = {
  name: "record_value",
  description: "Record the supplied value.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
};

function responseEvents(first: boolean, responseId = first ? "resp_number" : "resp_done") {
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
        id: responseId,
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
    const server = await createResponsesLoopbackServer((turn) => responseEvents(turn === 1));
    const { requests } = server;
    const run = async (messages: Context["messages"]) => {
      const stream = await createOpenAIResponsesTransportStreamFn()(
        responsesLoopbackModel,
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
      await server.close();
    }
  },
);

it.each(["sse", "websocket-cached"] as const)(
  "recovers real %s continuation after payload serialization fails",
  async (transport) => {
    const server = await createResponsesLoopbackServer((turn) =>
      responseEvents(false, `resp_${turn}`),
    );
    const run = async (messages: Context["messages"], failSerialization = false) => {
      const stream = await createOpenAIResponsesTransportStreamFn()(
        responsesLoopbackModel,
        { messages },
        {
          apiKey: "synthetic-continuation-key",
          sessionId: `serialization-${transport}`,
          transport,
          onPayload: (payload) => ({
            ...(payload as Record<string, unknown>),
            store: true,
            ...(failSerialization
              ? {
                  metadata: {
                    value: {
                      toJSON() {
                        throw new Error("synthetic continuation serialization failure");
                      },
                    },
                  },
                }
              : {}),
          }),
        },
      );
      return stream.result();
    };
    try {
      const user = { role: "user" as const, content: "First.", timestamp: 1 };
      const first = await run([user]);
      expect(first.stopReason).toBe("stop");
      const messages: Context["messages"] = [
        user,
        first,
        { role: "user", content: "Second.", timestamp: 2 },
      ];
      const failed = await run(messages, true);
      expect(failed.stopReason).toBe("error");
      expect(failed.errorMessage).toBe("synthetic continuation serialization failure");
      expect(server.requests).toHaveLength(1);

      const second = await run(messages);
      expect(second.stopReason).toBe("stop");
      expect(server.requests[1]).not.toHaveProperty("previous_response_id");
      expect(server.requests[1]?.input).toHaveLength(3);
      const third = await run([
        ...messages,
        second,
        { role: "user", content: "Third.", timestamp: 3 },
      ]);
      expect(third.stopReason).toBe("stop");
      expect(server.requests).toHaveLength(3);
      expect(server.requests[2]).toMatchObject({
        previous_response_id: "resp_2",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Third." }] },
        ],
      });
    } finally {
      await server.close();
    }
  },
);
