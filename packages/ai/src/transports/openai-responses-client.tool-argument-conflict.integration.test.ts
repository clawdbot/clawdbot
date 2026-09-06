// Transport-level proof for #139110: the argument reconciliation must hold on a
// real SSE connection and a real WebSocket session, not only on a parsed event
// iterator, because both transports reach the same completion owner.
import type { Context, Tool } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";

const updateTool: Tool = {
  name: "update_record",
  description: "Update a record behind an ETag precondition.",
  parameters: {
    type: "object",
    properties: { object_id: { type: "string" }, if_match: { type: "string" } },
    required: ["object_id", "if_match"],
    additionalProperties: false,
  },
};
const streamedArguments = '{"object_id":"x","if_match":"\\"rev-4\\""}';
const staleArguments = '{"object_id":"x","if_match":"\\"rev-"}';
const completeArguments = { object_id: "x", if_match: '"rev-4"' };
const scenarios = [
  { name: "conflicting", itemDone: staleArguments, terminal: streamedArguments },
  { name: "healthy", itemDone: streamedArguments, terminal: streamedArguments },
  { name: "item-done without arguments", itemDone: undefined, terminal: undefined },
] as const;

function responseEvents(scenario: (typeof scenarios)[number]) {
  const call = {
    type: "function_call",
    id: "fc_update",
    call_id: "call_update",
    name: updateTool.name,
    status: "completed",
  };
  const withArguments = (value: string | undefined) =>
    value === undefined ? call : { ...call, arguments: value };
  return () => [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: call.id,
      delta: streamedArguments.slice(0, 18),
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: call.id,
      delta: streamedArguments.slice(18),
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: withArguments(scenario.itemDone),
    },
    {
      type: "response.completed",
      response: {
        id: "resp_argument_conflict",
        status: "completed",
        output: [withArguments(scenario.terminal)],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
}

it.each(
  (["sse", "websocket-cached"] as const).flatMap((transport) =>
    scenarios.map((scenario) => ({ transport, scenario })),
  ),
)("real $transport stream: $scenario.name", async ({ transport, scenario }) => {
  const server = await createResponsesLoopbackServer(responseEvents(scenario));
  try {
    const context: Context = {
      messages: [{ role: "user", content: "Update record x.", timestamp: 1 }],
      tools: [updateTool],
    };
    const stream = await createOpenAIResponsesTransportStreamFn()(responsesLoopbackModel, context, {
      apiKey: "synthetic-key-a",
      sessionId: `${transport}-${scenario.name}`,
      cacheRetention: "none",
      transport,
    });
    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    const result = await stream.result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    // The request really left through the selected transport.
    expect(server.connections).toBe(transport === "sse" ? 0 : 1);
    expect(server.authorization).toEqual(["Bearer synthetic-key-a"]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.tools).toEqual([
      expect.objectContaining({ type: "function", name: updateTool.name }),
    ]);

    if (scenario.name === "conflicting") {
      expect(events).not.toContain("toolcall_end");
      expect(events).toContain("error");
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe(
        "Responses stream completed tool call with conflicting arguments",
      );
      // The started block stays unfinished with no arguments: the stale snapshot
      // never reaches the transcript, and no toolcall_end authorizes execution.
      expect(toolCalls).toEqual([
        expect.objectContaining({ name: updateTool.name, arguments: {} }),
      ]);
      expect(JSON.stringify(result.content)).not.toContain("rev-");
      return;
    }
    expect(result.stopReason).toBe("toolUse");
    expect(events.filter((type) => type === "toolcall_end")).toEqual(["toolcall_end"]);
    expect(toolCalls).toEqual([
      expect.objectContaining({ name: updateTool.name, arguments: completeArguments }),
    ]);
  } finally {
    await server.close();
  }
});
