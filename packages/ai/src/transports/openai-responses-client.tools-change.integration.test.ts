import type { Context, Tool } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";

const recordTool: Tool = {
  name: "record_value",
  description: "Record the supplied value.",
  parameters: {
    type: "object",
    properties: { n: { type: "integer" } },
    required: ["n"],
    additionalProperties: false,
  },
};
const verifyTool: Tool = { ...recordTool, name: "verify_value" };
const revisedTool: Tool = {
  ...recordTool,
  description: "Record the supplied value and its revision.",
  parameters: {
    type: "object",
    properties: { n: { type: "integer" }, revision: { type: "integer", const: 2 } },
    required: ["n", "revision"],
    additionalProperties: false,
  },
};
const scenarios = [
  { name: "added", before: [recordTool], after: [recordTool, verifyTool], continues: true },
  { name: "removed", before: [recordTool, verifyTool], after: [recordTool], continues: true },
  { name: "schema", before: [recordTool], after: [revisedTool], continues: true },
  { name: "empty", before: [recordTool], after: [], continues: true },
  { name: "omitted", before: [recordTool], after: undefined, continues: true },
  ...["history", "arguments", "tool-choice", "key", "session"].map((name) => ({
    name,
    before: [recordTool],
    after: [recordTool, verifyTool],
    continues: false,
  })),
];

function responseEvents(turn: number) {
  const item =
    turn === 1
      ? {
          type: "function_call",
          id: "fc_value",
          call_id: "call_value",
          name: recordTool.name,
          arguments: '{"n":7}',
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${turn}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `done ${turn}`, annotations: [] }],
        };
  return [
    ...(turn === 1
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
            delta: '{"n":7}',
          },
          { type: "response.output_item.done", output_index: 0, item },
        ]
      : []),
    {
      type: "response.completed",
      response: {
        id: `resp_${turn}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
}

it.each(
  (["sse", "websocket-cached"] as const).flatMap((transport) =>
    scenarios.map(({ name, before, after, continues }) => ({
      transport,
      name,
      before,
      after,
      continues,
    })),
  ),
)("real $transport continuation with $name tools", async ({ transport, ...scenario }) => {
  const server = await createResponsesLoopbackServer(responseEvents);
  const { requests, authorization } = server;
  const prepared: Array<Record<string, unknown>> = [];
  const run = async (context: Context, later = false) => {
    const stream = await createOpenAIResponsesTransportStreamFn()(responsesLoopbackModel, context, {
      apiKey: later && scenario.name === "key" ? "synthetic-key-b" : "synthetic-key-a",
      sessionId: `${transport}-${scenario.name}-${later && scenario.name === "session" ? "b" : "a"}`,
      cacheRetention: "none",
      transport,
      onPayload: (payload) => {
        const request = {
          ...(payload as Record<string, unknown>),
          store: true,
          tool_choice: later && scenario.name === "tool-choice" ? "none" : "auto",
        };
        prepared.push(request);
        return request;
      },
    });
    return stream.result();
  };
  try {
    const user = { role: "user" as const, content: "Record 7.", timestamp: 1 };
    const first = await run({ messages: [user], tools: scenario.before });
    expect(first.stopReason).toBe("toolUse");
    const firstSnapshot = structuredClone(first);
    const preparedSnapshot = structuredClone(prepared[0]);
    const call = first.content.find((block) => block.type === "toolCall");
    if (!call) {
      throw new Error("Expected a completed tool call");
    }
    const replay =
      scenario.name === "arguments"
        ? { ...first, content: [{ ...call, arguments: { n: "7" } }] }
        : first;
    const priorUser = scenario.name === "history" ? { ...user, content: "Record 8." } : user;
    const result = {
      role: "toolResult" as const,
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
      timestamp: 2,
    };
    const messages: Context["messages"] = [priorUser, replay, result];
    const second = await run({ messages, tools: scenario.after }, true);
    const nextUser = { role: "user" as const, content: "Continue.", timestamp: 3 };
    const third = await run(
      { messages: [...messages, second, nextUser], tools: scenario.after },
      true,
    );
    expect(second.stopReason).toBe("stop");
    expect(third.stopReason).toBe("stop");
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.type)).toEqual(
      transport === "websocket-cached"
        ? ["response.create", "response.create", "response.create"]
        : [undefined, undefined, undefined],
    );
    const identityChanged = ["key", "session"].includes(scenario.name);
    const socketCount = identityChanged ? 2 : 1;
    expect(server.connections).toBe(transport === "sse" ? 0 : socketCount);
    const firstAuthorization = "Bearer synthetic-key-a";
    const laterAuthorization =
      scenario.name === "key" ? "Bearer synthetic-key-b" : firstAuthorization;
    const expectedAuthorization =
      transport === "sse"
        ? [firstAuthorization, laterAuthorization, laterAuthorization]
        : identityChanged
          ? [firstAuthorization, laterAuthorization]
          : [firstAuthorization];
    expect(authorization).toEqual(expectedAuthorization);
    expect(first).toEqual(firstSnapshot);
    expect(prepared[0]).toEqual(preparedSnapshot);
    for (const turn of [1, 2]) {
      expect(requests[turn]?.tools).toEqual(prepared[turn]?.tools);
      expect(requests[turn]?.tool_choice).toBe(scenario.name === "tool-choice" ? "none" : "auto");
      if (scenario.after === undefined) {
        expect(requests[turn]).not.toHaveProperty("tools");
      } else {
        expect(requests[turn]?.tools).toEqual(
          scenario.after
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((tool) =>
              expect.objectContaining({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }),
            ),
        );
      }
    }
    expect(requests[2]).toMatchObject({
      previous_response_id: "resp_2",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ],
    });
    if (scenario.continues) {
      expect(requests[1], scenario.name).toMatchObject({
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_value", output: "ok" }],
      });
    } else {
      expect(requests[1], scenario.name).not.toHaveProperty("previous_response_id");
      expect(requests[1]?.input).toHaveLength(3);
    }
  } finally {
    await server.close();
  }
});
